import { HttpContext } from "@adonisjs/core/http";
import { NextFn } from "@adonisjs/core/types/http";
import { performance } from "perf_hooks";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { convertHeaders } from "../common/requestLogger.js";
import { ApitallyConsumer } from "../common/types.js";
import { parseContentLength } from "../common/utils.js";

declare module "@adonisjs/core/http" {
  interface HttpContext {
    apitallyConsumer?: ApitallyConsumer | string;
  }
}

export class ApitallyMiddleware {
  constructor(protected client: ApitallyClient) {}

  async handle(ctx: HttpContext, next: NextFn) {
    if (!this.client || !this.client.isEnabled()) {
      await next();
      return;
    }

    const startTime = performance.now();
    await next();
    const responseTime = performance.now() - startTime;
    const requestSize = parseContentLength(
      ctx.request.header("content-length"),
    );
    const responseSize = parseContentLength(
      ctx.response.getHeader("content-length"),
    );
    const path = ctx.route?.pattern;

    const consumer = ctx.apitallyConsumer
      ? consumerFromStringOrObject(ctx.apitallyConsumer)
      : null;
    this.client.consumerRegistry.addOrUpdateConsumer(consumer);

    if (path) {
      this.client.requestCounter.addRequest({
        consumer: consumer?.identifier,
        method: ctx.request.method(),
        path,
        statusCode: ctx.response.getStatus(),
        responseTime,
        requestSize,
        responseSize,
      });
    }

    if (this.client.requestLogger.enabled) {
      let requestBody;
      let responseBody;
      const requestContentType = ctx.request.header("content-type")?.toString();
      const responseContentType = ctx.response
        .getHeader("content-type")
        ?.toString();
      if (
        this.client.requestLogger.config.logRequestBody &&
        this.client.requestLogger.isSupportedContentType(requestContentType)
      ) {
        requestBody = ctx.request.raw();
      }
      if (
        this.client.requestLogger.config.logResponseBody &&
        this.client.requestLogger.isSupportedContentType(responseContentType)
      ) {
        responseBody = ctx.response.getBody();
      }

      this.client.requestLogger.logRequest(
        {
          timestamp: Date.now() / 1000,
          method: ctx.request.method(),
          path,
          url: ctx.request.completeUrl(true),
          headers: convertHeaders(ctx.request.headers()),
          size: requestSize,
          consumer: consumer?.identifier,
          body: requestBody ? Buffer.from(requestBody) : undefined,
        },
        {
          statusCode: ctx.response.getStatus(),
          responseTime: responseTime / 1000,
          headers: convertHeaders(ctx.response.getHeaders()),
          size: responseSize,
          body: responseBody ? Buffer.from(responseBody) : undefined,
        },
        undefined,
      );
    }
  }
}
