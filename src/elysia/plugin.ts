import { Context, Elysia, StatusMap, ValidationError } from "elysia";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { parseContentLength } from "../common/headers.js";
import type { LogRecord } from "../common/requestLogger.js";
import { convertHeaders } from "../common/requestLogger.js";
import {
  getResponseBody,
  measureResponseSize,
  teeResponse,
} from "../common/response.js";
import { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
import { patchConsole, patchWinston } from "../loggers/index.js";
import { getAppInfo } from "./utils.js";

const START_TIME_SYMBOL = Symbol("apitally.startTime");
const REQUEST_BODY_SYMBOL = Symbol("apitally.requestBody");
const RESPONSE_STATUS_SYMBOL = Symbol("apitally.responseStatus");
const RESPONSE_SIZE_SYMBOL = Symbol("apitally.responseSize");
const RESPONSE_HEADERS_SYMBOL = Symbol("apitally.responseHeaders");
const RESPONSE_BODY_SYMBOL = Symbol("apitally.responseBody");
const ERROR_SYMBOL = Symbol("apitally.error");

declare global {
  interface Request {
    [START_TIME_SYMBOL]?: number;
    [REQUEST_BODY_SYMBOL]?: Buffer;
    [RESPONSE_STATUS_SYMBOL]?: number;
    [RESPONSE_HEADERS_SYMBOL]?: Headers;
    [RESPONSE_BODY_SYMBOL]?: Buffer;
    [RESPONSE_SIZE_SYMBOL]?: number;
    [ERROR_SYMBOL]?: Readonly<Error>;
  }
}

interface ApitallyContext {
  consumer?: ApitallyConsumer | string;
}

export default function apitallyPlugin(config: ApitallyConfig) {
  const client = new ApitallyClient(config);
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

  if (client.requestLogger.config.captureLogs) {
    patchConsole(logsContext);
    patchWinston(logsContext);
  }

  return (app: Elysia) => {
    const handler = app["~adapter"].handler;
    const originalMapResponse = handler.mapResponse;
    const originalMapCompactResponse = handler.mapCompactResponse;
    const originalMapEarlyResponse = handler.mapEarlyResponse;

    const handleMappedResponse = (response: unknown, request?: Request) => {
      if (!(request instanceof Request) || !(response instanceof Response)) {
        return response;
      }

      request[RESPONSE_HEADERS_SYMBOL] = response.headers;
      request[RESPONSE_STATUS_SYMBOL] = response.status;
      const [newResponse1, newResponse2] = teeResponse(response);

      if (
        client.requestLogger.enabled &&
        client.requestLogger.config.logResponseBody &&
        client.requestLogger.isSupportedContentType(
          response.headers.get("content-type"),
        )
      ) {
        const captureResponseBody = async () => {
          const responseBody = (await getResponseBody(newResponse2, false))[0];
          request[RESPONSE_BODY_SYMBOL] = responseBody;
          request[RESPONSE_SIZE_SYMBOL] = responseBody.length;
        };
        captureResponseBody();
      } else {
        const captureResponseSize = async () => {
          const responseSize = (
            await measureResponseSize(newResponse2, false)
          )[0];
          request[RESPONSE_SIZE_SYMBOL] = responseSize;
        };
        captureResponseSize();
      }

      return newResponse1;
    };

    handler.mapResponse = function wrappedMapResponse(
      response: unknown,
      set: Context["set"],
      request?: Request,
    ) {
      const mappedResponse = originalMapResponse(response, set, request);
      const newResponse = handleMappedResponse(mappedResponse, request);
      return newResponse;
    };
    handler.mapCompactResponse = function wrappedMapCompactResponse(
      response: unknown,
      request?: Request,
    ) {
      const mappedResponse = originalMapCompactResponse(response, request);
      const newResponse = handleMappedResponse(mappedResponse, request);
      return newResponse;
    };
    handler.mapEarlyResponse = function wrappedMapEarlyResponse(
      response: unknown,
      set: Context["set"],
      request?: Request,
    ) {
      const mappedResponse = originalMapEarlyResponse(response, set, request);
      const newResponse = handleMappedResponse(mappedResponse, request);
      return newResponse;
    };

    return app
      .decorate("apitally", {} as ApitallyContext)
      .onStart(() => {
        const appInfo = getAppInfo(app, config.appVersion);
        client.setStartupData(appInfo);
      })
      .onStop(async () => {
        await client.handleShutdown();
      })
      .onRequest(async ({ request }) => {
        if (!client.isEnabled() || request.method.toUpperCase() === "OPTIONS") {
          return;
        }

        logsContext.enterWith([]);
        request[START_TIME_SYMBOL] = performance.now();

        // Capture request body for logging if enabled
        if (
          client.requestLogger.enabled &&
          client.requestLogger.config.logRequestBody
        ) {
          const contentType = request.headers.get("content-type");
          const requestSize =
            parseContentLength(request.headers.get("content-length")) ?? 0;

          if (
            client.requestLogger.isSupportedContentType(contentType) &&
            requestSize <= client.requestLogger.maxBodySize
          ) {
            try {
              request[REQUEST_BODY_SYMBOL] = Buffer.from(
                await request.clone().arrayBuffer(),
              );
            } catch (error) {
              // Ignore errors in body capture
            }
          }
        }
      })
      .onAfterResponse(async ({ request, set, route, apitally }) => {
        if (!client.isEnabled() || request.method.toUpperCase() === "OPTIONS") {
          return;
        }

        const startTime = request[START_TIME_SYMBOL];
        const responseTime = startTime ? performance.now() - startTime : 0;

        await setImmediate(); // Wait for the response to be captured

        const statusCode =
          request[RESPONSE_STATUS_SYMBOL] ?? getStatusCode(set) ?? 200;
        const requestSize = parseContentLength(
          request.headers.get("content-length"),
        );
        const responseSize = request[RESPONSE_SIZE_SYMBOL];
        const error = request[ERROR_SYMBOL];

        const consumer = apitally.consumer
          ? consumerFromStringOrObject(apitally.consumer)
          : null;
        client.consumerRegistry.addOrUpdateConsumer(consumer);

        if (route) {
          client.requestCounter.addRequest({
            consumer: consumer?.identifier,
            method: request.method,
            path: route,
            statusCode,
            responseTime,
            requestSize,
            responseSize,
          });

          // Handle server errors
          if (statusCode === 500 && error) {
            client.serverErrorCounter.addServerError({
              consumer: consumer?.identifier,
              method: request.method,
              path: route,
              type: error.name,
              msg: error.message,
              traceback: error.stack || "",
            });
          }

          // Handle validation errors
          if (
            (statusCode === 400 || statusCode === 422) &&
            error instanceof ValidationError
          ) {
            const parsedMessage = JSON.parse(error.message);
            client.validationErrorCounter.addValidationError({
              consumer: consumer?.identifier,
              method: request.method,
              path: route,
              loc:
                (parsedMessage.on ?? "") + "." + (parsedMessage.property ?? ""),
              msg: parsedMessage.message,
              type: "",
            });
          }
        }

        // Request logging
        if (client.requestLogger.enabled) {
          const logs = logsContext.getStore();
          client.requestLogger.logRequest(
            {
              timestamp: (Date.now() - responseTime) / 1000,
              method: request.method,
              path: route,
              url: request.url,
              headers: convertHeaders(
                Object.fromEntries(request.headers.entries()),
              ),
              size: requestSize,
              consumer: consumer?.identifier,
              body: request[REQUEST_BODY_SYMBOL],
            },
            {
              statusCode,
              responseTime: responseTime / 1000,
              headers: convertHeaders(request[RESPONSE_HEADERS_SYMBOL]),
              size: responseSize,
              body: request[RESPONSE_BODY_SYMBOL],
            },
            error,
            logs,
          );
        }
      })
      .onError(({ request, error }) => {
        if (client.isEnabled() && error instanceof Error) {
          request[ERROR_SYMBOL] = error;
        }
      });
  };
}

function getStatusCode(set: Context["set"]) {
  if (typeof set.status === "number") {
    return set.status;
  } else if (typeof set.status === "string") {
    return StatusMap[set.status];
  }
}
