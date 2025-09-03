import type { Request, Server } from "@hapi/hapi";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import type { LogRecord } from "../common/requestLogger.js";
import { convertHeaders } from "../common/requestLogger.js";
import { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
import {
  handleHapiRequestEvent,
  patchConsole,
  patchPinoLogger,
  patchWinston,
} from "../loggers/index.js";
import { getAppInfo, isBoom } from "./utils.js";

const START_TIME_SYMBOL = Symbol("apitally.startTime");
const PINO_LOGGER_PATCHED_SYMBOL = Symbol("apitally.pinoLoggerPatched");
const REQUEST_BODY_SYMBOL = Symbol("apitally.requestBody");
const REQUEST_SIZE_SYMBOL = Symbol("apitally.requestSize");
const RESPONSE_BODY_SYMBOL = Symbol("apitally.responseBody");
const RESPONSE_SIZE_SYMBOL = Symbol("apitally.responseSize");

declare module "@hapi/hapi" {
  interface Request {
    [START_TIME_SYMBOL]?: number;
    [PINO_LOGGER_PATCHED_SYMBOL]?: boolean;
    [REQUEST_BODY_SYMBOL]?: Buffer;
    [REQUEST_SIZE_SYMBOL]?: number;
    [RESPONSE_BODY_SYMBOL]?: Buffer;
    [RESPONSE_SIZE_SYMBOL]?: number;
    apitallyConsumer?: ApitallyConsumer | string;
  }

  interface ResponseObject {
    readonly contentType: string | null; // Missing in Hapi types
  }
}

export default function apitallyPlugin(config: ApitallyConfig) {
  const client = new ApitallyClient(config);
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

  if (client.requestLogger.enabled && client.requestLogger.config.captureLogs) {
    patchConsole(logsContext);
    patchWinston(logsContext);
  }

  return {
    name: "apitally",
    register: async function (server: Server) {
      server.ext("onPostStart", () => {
        const appInfo = getAppInfo(server, config.appVersion);
        client.setStartupData(appInfo);
      });

      server.ext("onPreStop", async () => {
        await client.handleShutdown();
      });

      server.events.on("request", (request, event) => {
        if (
          event.channel === "app" &&
          client.requestLogger.enabled &&
          client.requestLogger.config.captureLogs &&
          !request[PINO_LOGGER_PATCHED_SYMBOL]
        ) {
          handleHapiRequestEvent(event, logsContext);
        }
      });

      server.ext("onRequest", async (request, h) => {
        if (!client.isEnabled() || request.method.toUpperCase() === "OPTIONS") {
          return h.continue;
        }

        if (
          client.requestLogger.enabled &&
          client.requestLogger.config.captureLogs &&
          "logger" in request
        ) {
          request[PINO_LOGGER_PATCHED_SYMBOL] = await patchPinoLogger(
            (request as any).logger,
            logsContext,
          );
        }

        logsContext.enterWith([]);
        request[START_TIME_SYMBOL] = performance.now();

        const captureRequestBody =
          client.requestLogger.enabled &&
          client.requestLogger.config.logRequestBody &&
          client.requestLogger.isSupportedContentType(
            request.headers["content-type"],
          );
        const chunks: Buffer[] = [];
        let size = 0;
        request.events.on("peek", (chunk: string, encoding: string) => {
          if (captureRequestBody) {
            chunks.push(Buffer.from(chunk, encoding as BufferEncoding));
          }
          size += chunk.length;
        });
        request.events.once("finish", () => {
          if (chunks.length > 0) {
            request[REQUEST_BODY_SYMBOL] = Buffer.concat(chunks);
          }
          request[REQUEST_SIZE_SYMBOL] = size;
        });

        return h.continue;
      });

      server.ext("onPreResponse", async (request, h) => {
        if (
          !client.isEnabled() ||
          request.method.toUpperCase() === "OPTIONS" ||
          isBoom(request.response)
        ) {
          return h.continue;
        }

        const captureResponseBody =
          client.requestLogger.enabled &&
          client.requestLogger.config.logResponseBody &&
          client.requestLogger.isSupportedContentType(
            request.response.contentType,
          );
        const chunks: Buffer[] = [];
        let size = 0;
        request.response.events.on(
          "peek",
          (chunk: string, encoding: string) => {
            if (captureResponseBody) {
              chunks.push(Buffer.from(chunk, encoding as BufferEncoding));
            }
            size += chunk.length;
          },
        );
        request.response.events.once("finish", () => {
          if (chunks.length > 0) {
            request[RESPONSE_BODY_SYMBOL] = Buffer.concat(chunks);
          }
          request[RESPONSE_SIZE_SYMBOL] = size;
        });

        return h.continue;
      });

      server.ext("onPostResponse", async (request, h) => {
        if (!client.isEnabled() || request.method.toUpperCase() === "OPTIONS") {
          return h.continue;
        }

        const startTime = request[START_TIME_SYMBOL];
        const responseTime = startTime ? performance.now() - startTime : 0;
        const timestamp = (Date.now() - responseTime) / 1000;
        const requestBody = request[REQUEST_BODY_SYMBOL];
        const requestSize = request[REQUEST_SIZE_SYMBOL];
        const response = request.response;
        let statusCode: number;
        let responseHeaders: Record<string, any>;
        let responseBody = request[RESPONSE_BODY_SYMBOL];
        let responseSize = request[RESPONSE_SIZE_SYMBOL];
        const error = (response as any)._error;

        if (isBoom(response)) {
          // Handle Boom error object
          statusCode = response.output?.statusCode ?? 500;
          responseHeaders = response.output?.headers ?? {};
        } else {
          // Handle normal ResponseObject
          statusCode = response.statusCode ?? 200;
          responseHeaders = response.headers ?? {};
        }

        if (
          !responseBody &&
          (response as any)._payload &&
          client.requestLogger.enabled &&
          client.requestLogger.config.logResponseBody &&
          (isBoom(response) ||
            client.requestLogger.isSupportedContentType(response.contentType))
        ) {
          const responsePayload = (response as any)._payload;
          if (
            responsePayload &&
            responsePayload._data &&
            responsePayload._encoding &&
            typeof responsePayload._data === "string" &&
            typeof responsePayload._encoding === "string"
          ) {
            responseBody = Buffer.from(
              responsePayload._data,
              responsePayload._encoding as BufferEncoding,
            );
          }
        }

        if (!responseSize && responseBody) {
          responseSize = responseBody.length;
        }

        const consumer = request.apitallyConsumer
          ? consumerFromStringOrObject(request.apitallyConsumer)
          : null;
        client.consumerRegistry.addOrUpdateConsumer(consumer);

        if (request.route.path) {
          client.requestCounter.addRequest({
            consumer: consumer?.identifier,
            method: request.method,
            path: request.route.path,
            statusCode,
            responseTime,
            requestSize,
            responseSize,
          });

          if (statusCode === 500 && error instanceof Error) {
            client.serverErrorCounter.addServerError({
              consumer: consumer?.identifier,
              method: request.method,
              path: request.route.path,
              type: error.name,
              msg: error.message,
              traceback: error.stack || "",
            });
          }
        }

        if (client.requestLogger.enabled) {
          const logs = logsContext.getStore();
          client.requestLogger.logRequest(
            {
              timestamp,
              consumer: consumer?.identifier,
              method: request.method,
              path: request.route.path,
              url: request.url?.href || "",
              headers: convertHeaders(request.headers),
              size: requestSize,
              body: requestBody,
            },
            {
              statusCode,
              responseTime: responseTime / 1000,
              headers: convertHeaders(responseHeaders),
              size: responseSize,
              body: responseBody,
            },
            error,
            logs,
          );
        }

        return h.continue;
      });
    },
  };
}

export function setConsumer(
  request: Request,
  consumer: ApitallyConsumer | string | null | undefined,
) {
  request.apitallyConsumer = consumer || undefined;
}
