import type { H3Event, HTTPError } from "h3";
import { definePlugin, onError, onRequest, onResponse } from "h3";
import { performance } from "perf_hooks";
import type { ZodError } from "zod";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { mergeHeaders, parseContentLength } from "../common/headers.js";
import { convertHeaders } from "../common/requestLogger.js";
import { getResponseBody, measureResponseSize } from "../common/response.js";
import { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
import { getAppInfo } from "./utils.js";

declare module "h3" {
  interface H3EventContext {
    apitallyConsumer?: ApitallyConsumer | string;

    _apitallyRequestTimestamp?: number;
    _apitallyRequestBody?: Buffer<ArrayBuffer>;
  }
}

const jsonHeaders = new Headers({
  "content-type": "application/json;charset=UTF-8",
});

export const apitallyPlugin = definePlugin<ApitallyConfig>((app, config) => {
  const client = new ApitallyClient(config);

  const setStartupData = (attempt: number = 1) => {
    const appInfo = getAppInfo(app, config.appVersion);
    if (appInfo.paths.length > 0 || attempt >= 10) {
      client.setStartupData(appInfo);
    } else {
      setTimeout(() => setStartupData(attempt + 1), 1000);
    }
  };
  setTimeout(() => setStartupData(), 1000);

  const handleResponse = async (
    event: H3Event,
    response?: Response,
    error?: HTTPError,
  ) => {
    const startTime = event.context._apitallyRequestTimestamp;
    const responseTime = startTime ? performance.now() - startTime : 0;
    const path = event.context.matchedRoute?.route;
    const statusCode = response?.status || error?.status || 500;

    const requestSize = parseContentLength(
      event.req.headers.get("content-length"),
    );
    let responseSize = 0;
    let newResponse = response;
    if (response) {
      [responseSize, newResponse] = await measureResponseSize(response);
    }

    const consumer = getConsumer(event);
    client.consumerRegistry.addOrUpdateConsumer(consumer);

    if (path) {
      client.requestCounter.addRequest({
        consumer: consumer?.identifier,
        method: event.req.method,
        path,
        statusCode,
        responseTime,
        requestSize,
        responseSize,
      });

      if (error?.status === 400 && (error.data as any).name === "ZodError") {
        const zodError = error.data as ZodError;
        zodError.issues?.forEach((issue) => {
          client.validationErrorCounter.addValidationError({
            consumer: consumer?.identifier,
            method: event.req.method,
            path,
            loc: issue.path.join("."),
            msg: issue.message,
            type: issue.code,
          });
        });
      }

      if (error?.status === 500) {
        client.serverErrorCounter.addServerError({
          consumer: consumer?.identifier,
          method: event.req.method,
          path,
          type: error.name,
          msg: error.message,
          traceback: error.stack || "",
        });
      }
    }

    if (client.requestLogger.enabled) {
      const responseHeaders = response
        ? response.headers
        : error?.headers
          ? mergeHeaders(jsonHeaders, error.headers)
          : jsonHeaders;
      const responseContentType = responseHeaders.get("content-type");
      let responseBody;

      if (
        newResponse &&
        client.requestLogger.config.logResponseBody &&
        client.requestLogger.isSupportedContentType(responseContentType)
      ) {
        [responseBody, newResponse] = await getResponseBody(newResponse);
      } else if (error && client.requestLogger.config.logResponseBody) {
        responseBody = Buffer.from(JSON.stringify(error.toJSON()));
      }

      client.requestLogger.logRequest(
        {
          timestamp: (Date.now() - responseTime) / 1000,
          method: event.req.method,
          path,
          url: event.req.url,
          headers: convertHeaders(
            Object.fromEntries(event.req.headers.entries()),
          ),
          size: Number(requestSize),
          consumer: consumer?.identifier,
          body: event.context._apitallyRequestBody,
        },
        {
          statusCode,
          responseTime: responseTime / 1000,
          headers: responseHeaders
            ? convertHeaders(Object.fromEntries(responseHeaders.entries()))
            : [],
          size: responseSize,
          body: responseBody,
        },
      );
    }

    return newResponse;
  };

  app
    .use(
      onRequest(async (event) => {
        event.context._apitallyRequestTimestamp = performance.now();
        const requestContentType = event.req.headers.get("content-type");

        if (
          client.requestLogger.enabled &&
          client.requestLogger.config.logRequestBody &&
          client.requestLogger.isSupportedContentType(requestContentType)
        ) {
          const clonedRequest = event.req.clone();
          const requestBody = Buffer.from(await clonedRequest.arrayBuffer());
          event.context._apitallyRequestBody = requestBody;
        }
      }),
    )
    .use(
      onResponse((response, event) => {
        if (client.isEnabled()) {
          return handleResponse(event, response, undefined);
        }
      }),
    )
    .use(
      onError((error, event) => {
        if (client.isEnabled()) {
          return handleResponse(event, undefined, error);
        }
      }),
    );
});

function getConsumer(event: H3Event) {
  const consumer = event.context.apitallyConsumer;
  if (consumer) {
    return consumerFromStringOrObject(consumer);
  }
  return null;
}
