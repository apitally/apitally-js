import { Context, Hono } from "hono";
import { MiddlewareHandler } from "hono/types";
import { isMiddleware } from "hono/utils/handler";
import { performance } from "perf_hooks";
import type { ZodError } from "zod";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { getPackageVersion } from "../common/packageVersions.js";
import { convertHeaders } from "../common/requestLogger.js";
import {
  ApitallyConfig,
  ApitallyConsumer,
  PathInfo,
  StartupData,
  ValidationError,
} from "../common/types.js";

declare module "hono" {
  interface ContextVariableMap {
    apitallyConsumer?: ApitallyConsumer | string;
  }
}

export const useApitally = (app: Hono, config: ApitallyConfig) => {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(client);
  app.use(middleware);
  setTimeout(() => {
    client.setStartupData(getAppInfo(app, config.appVersion));
  }, 1000);
};

const getMiddleware = (client: ApitallyClient): MiddlewareHandler => {
  return async (c, next) => {
    if (!client.isEnabled()) {
      await next();
      return;
    }
    const startTime = performance.now();
    await next();
    let response;
    const responseTime = performance.now() - startTime;
    const [responseSize, newResponse] = await measureResponseSize(c.res);
    const requestSize = c.req.header("Content-Length");
    const consumer = getConsumer(c);
    client.consumerRegistry.addOrUpdateConsumer(consumer);
    client.requestCounter.addRequest({
      consumer: consumer?.identifier,
      method: c.req.method,
      path: c.req.routePath,
      statusCode: c.res.status,
      responseTime,
      requestSize,
      responseSize,
    });
    response = newResponse;
    if (c.res.status === 400) {
      const [responseJson, newResponse] = await getResponseJson(response);
      const validationErrors = extractZodErrors(responseJson);
      validationErrors.forEach((error) => {
        client.validationErrorCounter.addValidationError({
          consumer: consumer?.identifier,
          method: c.req.method,
          path: c.req.routePath,
          ...error,
        });
      });
      response = newResponse;
    }
    if (c.error) {
      client.serverErrorCounter.addServerError({
        consumer: consumer?.identifier,
        method: c.req.method,
        path: c.req.routePath,
        type: c.error.name,
        msg: c.error.message,
        traceback: c.error.stack || "",
      });
    }
    if (client.requestLogger.enabled) {
      let requestBody;
      let responseBody;
      let newResponse = response;
      if (client.requestLogger.config.logRequestBody) {
        requestBody = Buffer.from(await c.req.arrayBuffer());
      }
      if (client.requestLogger.config.logResponseBody) {
        [responseBody, newResponse] = await getResponseBody(response);
        response = newResponse;
      }
      client.requestLogger.logRequest(
        {
          timestamp: Date.now() / 1000,
          method: c.req.method,
          path: c.req.routePath,
          url: c.req.url,
          headers: convertHeaders(c.req.header()),
          size: Number(requestSize),
          consumer: consumer?.identifier,
          body: requestBody,
        },
        {
          statusCode: c.res.status,
          responseTime: responseTime / 1000,
          headers: convertHeaders(c.res.headers),
          size: responseSize,
          body: responseBody,
        },
      );
    }
    c.res = response;
  };
};

const getConsumer = (c: Context) => {
  const consumer = c.get("apitallyConsumer");
  if (consumer) {
    return consumerFromStringOrObject(consumer);
  }
  return null;
};

const measureResponseSize = async (
  response: Response,
): Promise<[number, Response]> => {
  const [newResponse1, newResponse2] = await teeResponse(response);
  let size = 0;
  if (newResponse2.body) {
    let done = false;
    const reader = newResponse2.body.getReader();
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (!done && result.value) {
        size += result.value.byteLength;
      }
    }
  }
  return [size, newResponse1];
};

const getResponseBody = async (
  response: Response,
): Promise<[Buffer, Response]> => {
  const [newResponse1, newResponse2] = await teeResponse(response);
  const responseBuffer = Buffer.from(await newResponse2.arrayBuffer());
  return [responseBuffer, newResponse1];
};

const getResponseJson = async (
  response: Response,
): Promise<[any, Response]> => {
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    const [newResponse1, newResponse2] = await teeResponse(response);
    const responseJson = await newResponse2.json();
    return [responseJson, newResponse1];
  }
  return [null, response];
};

const teeResponse = async (
  response: Response,
): Promise<[Response, Response]> => {
  if (!response.body) {
    return [response, response];
  }
  const [stream1, stream2] = response.body.tee();
  const newResponse1 = new Response(stream1, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const newResponse2 = new Response(stream2, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return [newResponse1, newResponse2];
};

const extractZodErrors = (responseJson: any) => {
  const errors: ValidationError[] = [];
  if (
    responseJson &&
    responseJson.success === false &&
    responseJson.error &&
    responseJson.error.name === "ZodError"
  ) {
    const zodError = responseJson.error as ZodError;
    zodError.issues.forEach((zodIssue) => {
      errors.push({
        loc: zodIssue.path.join("."),
        msg: zodIssue.message,
        type: zodIssue.code,
      });
    });
  }
  return errors;
};

const getAppInfo = (app: Hono, appVersion?: string): StartupData => {
  const versions: Array<[string, string]> = [];
  if (process.versions.node) {
    versions.push(["nodejs", process.versions.node]);
  }
  if (process.versions.bun) {
    versions.push(["bun", process.versions.bun]);
  }
  const honoVersion = getPackageVersion("hono");
  const apitallyVersion = getPackageVersion("../..");
  if (honoVersion) {
    versions.push(["hono", honoVersion]);
  }
  if (apitallyVersion) {
    versions.push(["apitally", apitallyVersion]);
  }
  if (appVersion) {
    versions.push(["app", appVersion]);
  }
  return {
    paths: listEndpoints(app),
    versions: Object.fromEntries(versions),
    client: "js:hono",
  };
};

const listEndpoints = (app: Hono) => {
  const endpoints: Array<PathInfo> = [];
  app.routes.forEach((route) => {
    if (route.method !== "ALL" && !isMiddleware(route.handler)) {
      endpoints.push({
        method: route.method.toUpperCase(),
        path: route.path,
      });
    }
  });
  return endpoints;
};
