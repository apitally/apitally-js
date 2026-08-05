import type { HttpContext } from "@adonisjs/core/http";
import type { NextFn } from "@adonisjs/core/types/http";
import { type Context, context } from "@opentelemetry/api";

import { isActivated } from "../activation.js";
import { getConfig } from "../config.js";
import { logWarning } from "../logger.js";
import { finalizeRequestObservation } from "../requestObservation.js";
import { captureNodeResponse, startNodeRequestObservation } from "../requestObservationNode.js";

const TRACER_NAME = "apitally.adonisjs";

export default class ApitallyMiddleware {
  async handle(ctx: HttpContext, next: NextFn): Promise<unknown> {
    if (!isActivated()) {
      return next();
    }

    let requestContext: Context | undefined;
    try {
      const request = ctx.request.request;
      const response = ctx.response.response;
      const started = startNodeRequestObservation({ request, tracerName: TRACER_NAME });
      requestContext = started.requestContext;
      context.bind(requestContext, request);
      context.bind(requestContext, response);
      captureNodeResponse(
        response,
        getConfig().captureResponseBody &&
          started.observation.requestRecord.dropReason === undefined,
        started.observation.requestBodyCapture,
        (name) => ctx.response.getHeader(name),
      )
        .then((completion) => {
          finalizeRequestObservation({
            observation: started.observation,
            completedAtMillis: completion.completedAtMillis,
            statusCode: response.statusCode,
            route: ctx.route?.pattern,
            requestHeaders: request.headers,
            responseHeaders: ctx.response.getHeaders(),
            capturedRequestBody: completion.requestBody,
            capturedResponseBody: completion,
          });
        })
        .catch((error: unknown) => {
          logWarning(`Error in the Apitally middleware: ${String(error)}`);
        });
    } catch (error) {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
    }

    return requestContext ? context.with(requestContext, next) : next();
  }
}
