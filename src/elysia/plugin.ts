import { Elysia, StatusMap } from "elysia";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { parseContentLength } from "../common/headers.js";
import type { LogRecord } from "../common/requestLogger.js";
import { convertBody, convertHeaders } from "../common/requestLogger.js";
import { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
import { patchConsole, patchWinston } from "../loggers/index.js";
import { getAppInfo } from "./utils.js";

interface ApitallyStore {
  startTime?: number;
  consumer?: ApitallyConsumer | string;
  requestBody?: Buffer;
  error?: Readonly<Error>;
}

export default function apitallyPlugin(config: ApitallyConfig) {
  const client = new ApitallyClient(config);
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

  if (client.requestLogger.config.captureLogs) {
    patchConsole(logsContext);
    patchWinston(logsContext);
  }

  const plugin = new Elysia({ aot: false })
    .state("apitally", {} as ApitallyStore)
    .onRequest(async ({ request, store }) => {
      console.log("onRequest");
      if (!client.isEnabled()) {
        return;
      }

      logsContext.enterWith([]);
      store.apitally.startTime = performance.now();

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
            const clonedRequest = request.clone();
            const requestBody = Buffer.from(await clonedRequest.arrayBuffer());
            store.apitally.requestBody = requestBody;
          } catch (error) {
            // Ignore errors in body capture
          }
        }
      }
    })
    .onAfterHandle(({ response }) => {
      console.log("onAfterHandle", response);
    })
    .onAfterResponse(({ request, response, store, path, set }) => {
      if (!client.isEnabled() || request.method.toUpperCase() === "OPTIONS") {
        return;
      }

      const startTime = store.apitally.startTime;
      const responseTime = startTime ? performance.now() - startTime : 0;
      const error = store.apitally.error;

      // Use error status if present, otherwise use set status
      let statusCode = getStatusCode(set.status);
      if (error && (error as any).status) {
        statusCode = (error as any).status;
      }

      const requestSize = parseContentLength(
        request.headers.get("content-length"),
      );
      const responseSize = parseContentLength(set.headers["content-length"]);

      const consumer = getConsumer(store.apitally);
      client.consumerRegistry.addOrUpdateConsumer(consumer);

      if (path) {
        client.requestCounter.addRequest({
          consumer: consumer?.identifier,
          method: request.method,
          path,
          statusCode,
          responseTime,
          requestSize,
          responseSize: error ? 0 : responseSize, // No response size for errors
        });

        // Handle server errors (500 status)
        if (statusCode === 500 && error) {
          client.serverErrorCounter.addServerError({
            consumer: consumer?.identifier,
            method: request.method,
            path,
            type: error.name,
            msg: error.message,
            traceback: error.stack || "",
          });
        }

        // Handle validation errors (400 status)
        if (statusCode === 400 && response && !error) {
          try {
            const responseBody =
              typeof response === "string"
                ? response
                : JSON.stringify(response);
            const parsedBody = JSON.parse(responseBody);

            // Handle Elysia/TypeBox validation errors
            if (
              parsedBody.type === "validation" &&
              Array.isArray(parsedBody.errors)
            ) {
              parsedBody.errors.forEach((validationError: any) => {
                client.validationErrorCounter.addValidationError({
                  consumer: consumer?.identifier,
                  method: request.method,
                  path,
                  loc: validationError.path || "",
                  msg: validationError.message || "",
                  type: validationError.type || "",
                });
              });
            }
          } catch (error) {
            // Ignore errors in validation error parsing
          }
        }
      }

      // Request logging
      if (client.requestLogger.enabled) {
        let responseBody;
        const responseContentType = set.headers["content-type"] as string;

        if (
          client.requestLogger.config.logResponseBody &&
          client.requestLogger.isSupportedContentType(responseContentType)
        ) {
          try {
            responseBody = convertBody(response, responseContentType);
          } catch (error) {
            // Ignore errors in response body conversion
          }
        }

        const logs = logsContext.getStore();
        client.requestLogger.logRequest(
          {
            timestamp: (Date.now() - responseTime) / 1000,
            method: request.method,
            path,
            url: request.url,
            headers: convertHeaders(
              Object.fromEntries(request.headers.entries()),
            ),
            size: requestSize,
            consumer: consumer?.identifier,
            body: store.apitally.requestBody,
          },
          {
            statusCode,
            responseTime: responseTime / 1000,
            headers: convertHeaders(set.headers),
            size: responseSize,
            body: responseBody,
          },
          error,
          logs,
        );
      }
    })
    .onError(({ error, store }) => {
      if (client.isEnabled() && error instanceof Error) {
        store.apitally.error = error;
      }
    });

  // Set startup data after a delay to ensure routes are registered
  setTimeout(() => {
    const setStartupData = (attempt: number = 1) => {
      const appInfo = getAppInfo(plugin as any, config.appVersion);
      if (appInfo.paths.length > 0 || attempt >= 10) {
        client.setStartupData(appInfo);
      } else {
        setTimeout(() => setStartupData(attempt + 1), 500);
      }
    };
    setStartupData();
  }, 500);

  return plugin;
}

export function setConsumer(
  store: any,
  consumer: ApitallyConsumer | string | null | undefined,
) {
  if (store.apitally) {
    const apitallyStore = store.apitally as ApitallyStore;
    apitallyStore.consumer = consumer || undefined;
  }
}

function getConsumer(apitallyStore: ApitallyStore) {
  const consumer = apitallyStore.consumer;
  if (consumer) {
    return consumerFromStringOrObject(consumer);
  }
  return null;
}

function getStatusCode(status?: number | keyof StatusMap) {
  if (typeof status === "number") {
    return status;
  }
  if (typeof status === "string" && status in StatusMap) {
    return StatusMap[status as keyof StatusMap];
  }
  return 200;
}
