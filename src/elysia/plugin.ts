import { Context, Elysia, StatusMap, ValidationError } from "elysia";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { parseContentLength } from "../common/headers.js";
import type { LogRecord } from "../common/requestLogger.js";
import { convertHeaders } from "../common/requestLogger.js";
import { CapturedResponse, captureResponse } from "../common/response.js";
import { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
import { patchConsole, patchWinston } from "../loggers/index.js";
import { getAppInfo } from "./utils.js";

const START_TIME_SYMBOL = Symbol("apitally.startTime");
const REQUEST_BODY_SYMBOL = Symbol("apitally.requestBody");
const RESPONSE_SYMBOL = Symbol("apitally.response");
const RESPONSE_PROMISE_SYMBOL = Symbol("apitally.responsePromise");
const ERROR_SYMBOL = Symbol("apitally.error");
const CLIENT_SYMBOL = Symbol("apitally.client");

declare global {
  interface Request {
    [START_TIME_SYMBOL]?: number;
    [REQUEST_BODY_SYMBOL]?: Buffer;
    [RESPONSE_SYMBOL]?: Response;
    [RESPONSE_PROMISE_SYMBOL]?: Promise<CapturedResponse>;
    [ERROR_SYMBOL]?: Readonly<Error>;
    [CLIENT_SYMBOL]?: ApitallyClient;
  }
}

interface ApitallyContext {
  consumer?: ApitallyConsumer | string;
}

export default function apitallyPlugin(config: ApitallyConfig) {
  const client = new ApitallyClient(config);
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

  if (client.requestLogger.enabled && client.requestLogger.config.captureLogs) {
    patchConsole(logsContext);
    patchWinston(logsContext);
  }

  return (app: Elysia) => {
    const handler = app["~adapter"].handler;

    if (!handler.mapResponse.name.startsWith("wrapped")) {
      const originalMapResponse = handler.mapResponse;
      const originalMapCompactResponse = handler.mapCompactResponse;
      const originalMapEarlyResponse = handler.mapEarlyResponse;

      const captureMappedResponse = (
        originalResponse: unknown,
        mappedResponse: unknown,
        request?: Request,
      ) => {
        if (
          request instanceof Request &&
          mappedResponse instanceof Response &&
          !(RESPONSE_SYMBOL in request) &&
          CLIENT_SYMBOL in request
        ) {
          if (typeof originalResponse === "string") {
            // Preserve the response body value as Blob if the original response is a string,
            // so that Bun adds a Content-Type header.
            const responseBody = Buffer.from(originalResponse as string);
            request[RESPONSE_SYMBOL] = mappedResponse;
            request[RESPONSE_PROMISE_SYMBOL] = Promise.resolve({
              body: responseBody,
              size: responseBody.length,
              completed: true,
            });
          } else {
            // Otherwise capture the response using streaming
            const client = request[CLIENT_SYMBOL]!;
            const [newResponse, responsePromise] = captureResponse(
              mappedResponse,
              {
                captureBody:
                  client.requestLogger.enabled &&
                  client.requestLogger.config.logResponseBody,
                maxBodySize: client.requestLogger.maxBodySize,
              },
            );
            request[RESPONSE_SYMBOL] = newResponse;
            request[RESPONSE_PROMISE_SYMBOL] = responsePromise;
            return newResponse;
          }
        }
        return mappedResponse;
      };

      handler.mapResponse = function wrappedMapResponse(
        response: unknown,
        set: Context["set"],
        request?: Request,
      ) {
        const mappedResponse = originalMapResponse(response, set, request);
        const newResponse = captureMappedResponse(
          response,
          mappedResponse,
          request,
        );
        return newResponse;
      };
      handler.mapCompactResponse = function wrappedMapCompactResponse(
        response: unknown,
        request?: Request,
      ) {
        const mappedResponse = originalMapCompactResponse(response, request);
        const newResponse = captureMappedResponse(
          response,
          mappedResponse,
          request,
        );
        return newResponse;
      };
      handler.mapEarlyResponse = function wrappedMapEarlyResponse(
        response: unknown,
        set: Context["set"],
        request?: Request,
      ) {
        const mappedResponse = originalMapEarlyResponse(response, set, request);
        const newResponse = captureMappedResponse(
          response,
          mappedResponse,
          request,
        );
        return newResponse;
      };
    }

    return app
      .decorate("apitally", {} as ApitallyContext)
      .onStart(() => {
        const appInfo = getAppInfo(app, config.appVersion);
        client.setStartupData(appInfo);
        client.startSync();
      })
      .onStop(async () => {
        await client.handleShutdown();
      })
      .onRequest(async ({ request }) => {
        if (!client.isEnabled() || request.method.toUpperCase() === "OPTIONS") {
          return;
        }

        request[CLIENT_SYMBOL] = client;
        request[START_TIME_SYMBOL] = performance.now();
        logsContext.enterWith([]);

        // Capture request body
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
              // ignore
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

        const requestBody = request[REQUEST_BODY_SYMBOL];
        const requestSize =
          parseContentLength(request.headers.get("content-length")) ??
          requestBody?.length;

        let responsePromise = request[RESPONSE_PROMISE_SYMBOL];
        let response = request[RESPONSE_SYMBOL];
        const error = request[ERROR_SYMBOL];

        if (
          !response &&
          error &&
          "toResponse" in error &&
          typeof error.toResponse === "function"
        ) {
          // Convert error to response
          try {
            response = error.toResponse() as Response;
            const errorResponseBody = Buffer.from(await response.arrayBuffer());
            responsePromise = Promise.resolve({
              body: errorResponseBody,
              size: errorResponseBody.length,
              completed: true,
            });
          } catch (error) {
            // ignore
          }
        }

        const statusCode = response?.status ?? getStatusCode(set) ?? 200;

        if (!response) {
          // Create empty fake response for errors without the toResponse method
          response = new Response(null, {
            status: statusCode,
            statusText: "",
            headers: new Headers(),
          });
          responsePromise = Promise.resolve({
            body: undefined,
            size: 0,
            completed: true,
          });
        }

        const consumer = apitally.consumer
          ? consumerFromStringOrObject(apitally.consumer)
          : null;
        client.consumerRegistry.addOrUpdateConsumer(consumer);

        // Log request when response has been fully captured
        responsePromise?.then(async (capturedResponse) => {
          const responseHeaders = response?.headers ?? set.headers;
          const responseSize = capturedResponse.completed
            ? capturedResponse.size
            : undefined;

          client.requestCounter.addRequest({
            consumer: consumer?.identifier,
            method: request.method,
            path: route,
            statusCode,
            responseTime,
            requestSize,
            responseSize,
          });

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
                body: requestBody,
              },
              {
                statusCode,
                responseTime: responseTime / 1000,
                headers: convertHeaders(responseHeaders),
                size: responseSize,
                body: capturedResponse.body,
              },
              error,
              logs,
            );
          }
        });

        // Handle validation errors
        if (
          (statusCode === 400 || statusCode === 422) &&
          error instanceof ValidationError
        ) {
          try {
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
          } catch (error) {
            // ignore
          }
        }

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
