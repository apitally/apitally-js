import type { H3Event, HTTPError } from "h3";
import { definePlugin, onError, onRequest, onResponse } from "h3";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { ZodError } from "zod";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { mergeHeaders, parseContentLength } from "../common/headers.js";
import type { LogRecord } from "../common/requestLogger.js";
import { convertHeaders } from "../common/requestLogger.js";
import { captureResponse } from "../common/response.js";
import type { SpanHandle } from "../common/spanCollector.js";
import { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
import { patchConsole, patchWinston } from "../loggers/index.js";
import { getAppInfo } from "./utils.js";

const REQUEST_TIMESTAMP_SYMBOL = Symbol("apitally.requestTimestamp");
const REQUEST_BODY_SYMBOL = Symbol("apitally.requestBody");
const SPAN_HANDLE_SYMBOL = Symbol("apitally.spanHandle");

declare module "h3" {
  interface H3EventContext {
    apitallyConsumer?: ApitallyConsumer | string;

    [REQUEST_TIMESTAMP_SYMBOL]?: number;
    [REQUEST_BODY_SYMBOL]?: Buffer;
    [SPAN_HANDLE_SYMBOL]?: SpanHandle;
  }
}

const jsonHeaders = new Headers({
  "content-type": "application/json;charset=UTF-8",
});

export const apitallyPlugin = definePlugin<ApitallyConfig>((app, config) => {
  const client = new ApitallyClient(config);
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

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

  if (client.requestLogger.config.captureLogs) {
    patchConsole(logsContext);
    patchWinston(logsContext);
  }

  const handleResponse = async (
    event: H3Event,
    response?: Response,
    error?: HTTPError,
  ) => {
    if (event.req.method.toUpperCase() === "OPTIONS") {
      return response;
    }

    const startTime = event.context[REQUEST_TIMESTAMP_SYMBOL];
    const path = event.context.matchedRoute?.route;

    const consumer = getConsumer(event);
    client.consumerRegistry.addOrUpdateConsumer(consumer);

    if (!response) {
      response = new Response(null, {
        status: error?.status || 500,
        statusText: error?.statusText || "Internal Server Error",
        headers: error?.headers
          ? mergeHeaders(jsonHeaders, error.headers)
          : jsonHeaders,
      });
    }

    const [newResponse, responsePromise] = captureResponse(response, {
      captureBody:
        client.requestLogger.enabled &&
        client.requestLogger.config.logResponseBody,
      maxBodySize: client.requestLogger.maxBodySize,
    });

    responsePromise.then(async (capturedResponse) => {
      const responseTime = startTime ? performance.now() - startTime : 0;

      const spanHandle = event.context[SPAN_HANDLE_SYMBOL];
      spanHandle?.setName(`${event.req.method} ${path}`);
      const spans = spanHandle?.end();

      const responseSize = capturedResponse.completed
        ? capturedResponse.size
        : undefined;
      const requestSize = parseContentLength(
        event.req.headers.get("content-length"),
      );

      if (path) {
        client.requestCounter.addRequest({
          consumer: consumer?.identifier,
          method: event.req.method,
          path,
          statusCode: response.status,
          responseTime,
          requestSize,
          responseSize,
        });
      }

      if (client.requestLogger.enabled) {
        const logs = logsContext.getStore();
        client.requestLogger.logRequest(
          {
            timestamp: (Date.now() - responseTime) / 1000,
            method: event.req.method,
            path,
            url: event.req.url,
            headers: convertHeaders(
              Object.fromEntries(event.req.headers.entries()),
            ),
            size: requestSize,
            consumer: consumer?.identifier,
            body: event.context[REQUEST_BODY_SYMBOL],
          },
          {
            statusCode: response.status,
            responseTime: responseTime / 1000,
            headers: convertHeaders(
              Object.fromEntries(response.headers.entries()),
            ),
            size: responseSize,
            body: capturedResponse.body,
          },
          error?.cause instanceof Error ? error.cause : undefined,
          logs,
          spans,
        );
      }
    });

    if (
      path &&
      error?.status === 400 &&
      error.data &&
      (error.data as any).name === "ZodError"
    ) {
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

    if (path && error?.status === 500 && error.cause instanceof Error) {
      client.serverErrorCounter.addServerError({
        consumer: consumer?.identifier,
        method: event.req.method,
        path,
        type: error.cause.name,
        msg: error.cause.message,
        traceback: error.cause.stack || "",
      });
    }

    return newResponse;
  };

  app
    .use(
      onRequest(async (event) => {
        logsContext.enterWith([]);
        event.context[REQUEST_TIMESTAMP_SYMBOL] = performance.now();

        const spanHandle = client.spanCollector.startSpan();
        event.context[SPAN_HANDLE_SYMBOL] = spanHandle;
        spanHandle.enterContext();

        const requestContentType = event.req.headers.get("content-type");
        const requestSize =
          parseContentLength(event.req.headers.get("content-length")) ?? 0;

        if (
          client.requestLogger.enabled &&
          client.requestLogger.config.logRequestBody &&
          client.requestLogger.isSupportedContentType(requestContentType) &&
          requestSize <= client.requestLogger.maxBodySize
        ) {
          const clonedRequest = event.req.clone();
          const requestBody = Buffer.from(await clonedRequest.arrayBuffer());
          event.context[REQUEST_BODY_SYMBOL] = requestBody;
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
          handleResponse(event, undefined, error);
        }
      }),
    );
});

export function setConsumer(
  event: H3Event,
  consumer: ApitallyConsumer | string | null | undefined,
) {
  event.context.apitallyConsumer = consumer || undefined;
}

function getConsumer(event: H3Event) {
  const consumer = event.context.apitallyConsumer;
  if (consumer) {
    return consumerFromStringOrObject(consumer);
  }
  return null;
}
