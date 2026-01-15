import { Context, Hono } from "hono";
import { MiddlewareHandler } from "hono/types";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { parseContentLength } from "../common/headers.js";
import type { LogRecord } from "../common/requestLogger.js";
import { convertHeaders } from "../common/requestLogger.js";
import { captureResponse, getResponseJson } from "../common/response.js";
import { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
import { patchConsole, patchWinston } from "../loggers/index.js";
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
      client.startSync();
    } else {
      setTimeout(() => setStartupData(attempt + 1), 500);
    }
  };
  setTimeout(() => setStartupData(), 500);
}

function getMiddleware(client: ApitallyClient): MiddlewareHandler {
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

  if (client.requestLogger.config.captureLogs) {
    patchConsole(logsContext);
    patchWinston(logsContext);
  }

  return async (c, next) => {
    if (!client.isEnabled() || c.req.method.toUpperCase() === "OPTIONS") {
      await next();
      return;
    }

    await logsContext.run([], async () => {
      const timestamp = Date.now() / 1000;
      const startTime = performance.now();

      const getSpanName = () => `${c.req.method} ${c.req.routePath}`;
      const { spans } = await client.spanCollector.collect(next, getSpanName);

      const [newResponse, responsePromise] = captureResponse(c.res, {
        captureBody:
          (client.requestLogger.enabled &&
            client.requestLogger.config.logResponseBody &&
            client.requestLogger.isSupportedContentType(
              c.res.headers.get("content-type"),
            )) ||
          (c.res.status === 400 &&
            c.res.headers.get("content-type") === "application/json"),
        maxBodySize: client.requestLogger.maxBodySize,
      });
      c.res = newResponse;

      const statusCode = c.res.status;
      const responseHeaders = c.res.headers;

      responsePromise.then(async (capturedResponse) => {
        const responseTime = performance.now() - startTime;
        const requestSize = parseContentLength(c.req.header("content-length"));
        const responseSize = capturedResponse.completed
          ? capturedResponse.size
          : undefined;

        const consumer = getConsumer(c);
        client.consumerRegistry.addOrUpdateConsumer(consumer);

        client.requestCounter.addRequest({
          consumer: consumer?.identifier,
          method: c.req.method,
          path: c.req.routePath,
          statusCode,
          responseTime,
          requestSize,
          responseSize,
        });

        if (statusCode === 400 && capturedResponse.body) {
          const responseJson = getResponseJson(capturedResponse.body);
          const validationErrors = extractZodErrors(responseJson);
          validationErrors.forEach((error) => {
            client.validationErrorCounter.addValidationError({
              consumer: consumer?.identifier,
              method: c.req.method,
              path: c.req.routePath,
              ...error,
            });
          });
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
          const responseBody = capturedResponse.body;
          const requestContentType = c.req.header("content-type");
          if (
            client.requestLogger.config.logRequestBody &&
            client.requestLogger.isSupportedContentType(requestContentType)
          ) {
            requestBody = Buffer.from(await c.req.arrayBuffer());
          }
          const logs = logsContext.getStore();
          client.requestLogger.logRequest(
            {
              timestamp,
              method: c.req.method,
              path: c.req.routePath,
              url: c.req.url,
              headers: convertHeaders(c.req.header()),
              size: requestSize,
              consumer: consumer?.identifier,
              body: requestBody,
            },
            {
              statusCode: statusCode,
              responseTime: responseTime / 1000,
              headers: convertHeaders(responseHeaders),
              size: responseSize,
              body: responseBody,
            },
            c.error,
            logs,
            spans,
          );
        }
      });
    });
  };
}

export function setConsumer(
  c: Context,
  consumer: ApitallyConsumer | string | null | undefined,
) {
  c.set("apitallyConsumer", consumer || undefined);
}

function getConsumer(c: Context) {
  const consumer = c.get("apitallyConsumer");
  if (consumer) {
    return consumerFromStringOrObject(consumer);
  }
  return null;
}
