import { HttpContext } from "@adonisjs/core/http";
import { NextFn } from "@adonisjs/core/types/http";
import type { OutgoingHttpHeaders } from "http";
import { performance } from "perf_hooks";

import type { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { convertHeaders } from "../common/requestLogger.js";
import type { ApitallyConsumer } from "../common/types.js";
import { parseContentLength } from "../common/utils.js";

declare module "@adonisjs/core/http" {
  interface HttpContext {
    apitallyConsumer?: ApitallyConsumer | string;
    apitallyError?: Error;
  }
}

export default class ApitallyMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const client: ApitallyClient =
      await ctx.containerResolver.make("apitallyClient");

    if (!client.isEnabled()) {
      await next();
      return;
    }

    const path = ctx.route?.pattern;
    const timestamp = Date.now() / 1000;
    const startTime = performance.now();

    await next();

    const responseTime = performance.now() - startTime;
    const requestSize = parseContentLength(
      ctx.request.header("content-length"),
    );
    const requestContentType = ctx.request.header("content-type")?.toString();
    let responseStatus = ctx.response.getStatus();
    let responseHeaders = ctx.response.getHeaders();
    let responseSize: number | undefined;
    let responseContentType: string | undefined;

    const consumer = ctx.apitallyConsumer
      ? consumerFromStringOrObject(ctx.apitallyConsumer)
      : null;
    client.consumerRegistry.addOrUpdateConsumer(consumer);

    const onWriteHead = (statusCode: number, headers: OutgoingHttpHeaders) => {
      responseStatus = statusCode;
      responseHeaders = headers;
      responseSize = parseContentLength(headers["content-length"]);
      responseContentType = headers["content-type"]?.toString();
      if (path) {
        client.requestCounter.addRequest({
          consumer: consumer?.identifier,
          method: ctx.request.method(),
          path,
          statusCode: responseStatus,
          responseTime,
          requestSize,
          responseSize,
        });

        if (
          responseStatus === 422 &&
          ctx.apitallyError &&
          "code" in ctx.apitallyError &&
          "messages" in ctx.apitallyError &&
          ctx.apitallyError.code === "E_VALIDATION_ERROR" &&
          Array.isArray(ctx.apitallyError.messages)
        ) {
          ctx.apitallyError.messages.forEach((message) => {
            client.validationErrorCounter.addValidationError({
              consumer: consumer?.identifier,
              method: ctx.request.method(),
              path,
              loc: message.field,
              msg: message.message,
              type: message.rule,
            });
          });
        }

        if (responseStatus === 500 && ctx.apitallyError) {
          client.serverErrorCounter.addServerError({
            consumer: consumer?.identifier,
            method: ctx.request.method(),
            path,
            type: ctx.apitallyError.name,
            msg: ctx.apitallyError.message,
            traceback: ctx.apitallyError.stack || "",
          });
        }
      }
    };

    // Capture the final status code and response headers just before they are sent
    const originalWriteHead = ctx.response.response.writeHead;
    ctx.response.response.writeHead = (...args: any) => {
      originalWriteHead.apply(ctx.response.response, args);
      onWriteHead(args[0], typeof args[1] === "string" ? args[2] : args[1]);
      return ctx.response.response;
    };

    if (client.requestLogger.enabled) {
      const onEnd = (chunk: any) => {
        const requestBody =
          client.requestLogger.config.logRequestBody &&
          client.requestLogger.isSupportedContentType(requestContentType)
            ? ctx.request.raw()
            : undefined;
        const responseBody =
          client.requestLogger.config.logResponseBody &&
          client.requestLogger.isSupportedContentType(responseContentType)
            ? chunk
            : undefined;

        client.requestLogger.logRequest(
          {
            timestamp,
            method: ctx.request.method(),
            path,
            url: ctx.request.completeUrl(true),
            headers: convertHeaders(ctx.request.headers()),
            size: requestSize,
            consumer: consumer?.identifier,
            body: requestBody ? Buffer.from(requestBody) : undefined,
          },
          {
            statusCode: responseStatus,
            responseTime: responseTime / 1000,
            headers: convertHeaders(responseHeaders),
            size: responseSize,
            body: responseBody ? Buffer.from(responseBody) : undefined,
          },
          ctx.apitallyError,
        );
      };

      // Capture the final response body just before it is sent
      const originalEnd = ctx.response.response.end;
      ctx.response.response.end = (...args: any) => {
        originalEnd.apply(ctx.response.response, args);
        onEnd(typeof args[0] !== "function" ? args[0] : undefined);
        return ctx.response.response;
      };
    }
  }
}
