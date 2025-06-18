import { Context, Hono } from "hono";
import { MiddlewareHandler } from "hono/types";
import { performance } from "perf_hooks";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { parseContentLength } from "../common/headers.js";
import { convertHeaders } from "../common/requestLogger.js";
import {
  getResponseBody,
  getResponseJson,
  measureResponseSize,
} from "../common/response.js";
import { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
import { extractZodErrors, getAppInfo } from "./utils.js";

declare module "hono" {
  interface ContextVariableMap {
    apitallyConsumer?: ApitallyConsumer | string;
  }
}

export function useApitally(app: Hono, config: ApitallyConfig) {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(client);
  app.use(middleware);

  const setStartupData = (attempt: number = 1) => {
    const appInfo = getAppInfo(app, config.appVersion);
    if (appInfo.paths.length > 0 || attempt >= 10) {
      client.setStartupData(appInfo);
    } else {
      setTimeout(() => setStartupData(attempt + 1), 500);
    }
  };
  setTimeout(() => setStartupData(), 500);
}

function getMiddleware(client: ApitallyClient): MiddlewareHandler {
  return async (c, next) => {
    if (!client.isEnabled()) {
      await next();
      return;
    }

    const timestamp = Date.now() / 1000;
    const startTime = performance.now();

    await next();

    let response;
    const responseTime = performance.now() - startTime;
    const [responseSize, newResponse] = await measureResponseSize(c.res);
    const requestSize = parseContentLength(c.req.header("content-length"));

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
      const requestContentType = c.req.header("content-type");
      const responseContentType = c.res.headers.get("content-type");
      if (
        client.requestLogger.config.logRequestBody &&
        client.requestLogger.isSupportedContentType(requestContentType)
      ) {
        requestBody = Buffer.from(await c.req.arrayBuffer());
      }
      if (
        client.requestLogger.config.logResponseBody &&
        client.requestLogger.isSupportedContentType(responseContentType)
      ) {
        [responseBody, newResponse] = await getResponseBody(response);
        response = newResponse;
      }
      client.requestLogger.logRequest(
        {
          timestamp,
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
        c.error,
      );
    }
    c.res = response;
  };
}

export function getConsumer(c: Context) {
  const consumer = c.get("apitallyConsumer");
  if (consumer) {
    return consumerFromStringOrObject(consumer);
  }
  return null;
}
