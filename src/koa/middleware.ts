import { type Context, context } from "@opentelemetry/api";

import type Koa = require("koa");

import { activate, isActivated } from "../activation.js";
import { getConfig } from "../config.js";
import { captureException } from "../exceptions.js";
import { logDebug, logWarning } from "../logger.js";
import { finalizeRequestObservation } from "../requestObservation.js";
import {
  captureNodeResponse,
  type NodeRequestObservation,
  registerServerCloseFlush,
  startNodeRequestObservation,
} from "../requestObservationNode.js";
import { resolveMatchedRoute } from "./routes.js";

const MIDDLEWARE_MARKER = Symbol.for("apitally.koaMiddleware");
const TRACER_NAME = "apitally.koa";

interface KoaRequestObservation extends NodeRequestObservation {
  route?: string;
}

interface ObservedRequestStart {
  observation: KoaRequestObservation;
  requestContext: Context;
}

export function installKoaMiddleware(app: Koa): void {
  const markedApp = app as unknown as Record<symbol, boolean | undefined>;
  if (markedApp[MIDDLEWARE_MARKER] === true) {
    return;
  }
  markedApp[MIDDLEWARE_MARKER] = true;
  warnIfMiddlewareAlreadyRegistered(app);

  app.use(async (ctx, next) => {
    let started: ObservedRequestStart | undefined;
    try {
      started = observeRequest(ctx);
    } catch (error) {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
    }
    if (!started) {
      await next();
      return;
    }

    try {
      await context.with(started.requestContext, next);
    } catch (error) {
      const candidate =
        typeof error === "object" && error !== null
          ? (error as { status?: unknown; statusCode?: unknown })
          : undefined;
      const statusCode =
        typeof candidate?.status === "number"
          ? candidate.status
          : typeof candidate?.statusCode === "number"
            ? candidate.statusCode
            : undefined;
      if (statusCode === undefined || statusCode >= 500) {
        context.with(started.requestContext, () => captureException(error));
      }
      throw error;
    } finally {
      started.observation.route = resolveMatchedRoute(ctx);
    }
  });
}

function observeRequest(ctx: Koa.Context): ObservedRequestStart | undefined {
  activate();
  if (!isActivated()) {
    return undefined;
  }
  registerServerCloseFlush(ctx.req);
  const started = startNodeRequestObservation({ request: ctx.req, tracerName: TRACER_NAME });
  context.bind(started.requestContext, ctx.req);
  context.bind(started.requestContext, ctx.res);
  const observation: KoaRequestObservation = started.observation;
  captureNodeResponse(
    ctx.res,
    getConfig().captureResponseBody && observation.requestRecord.dropReason === undefined,
    observation.requestBodyCapture,
  )
    .then((completion) => {
      finalizeRequestObservation({
        observation,
        completedAtMillis: completion.completedAtMillis,
        statusCode: ctx.res.statusCode,
        route: observation.route ?? resolveMatchedRoute(ctx),
        clientAddress: ctx.ip,
        requestHeaders: ctx.req.headers,
        responseHeaders: ctx.res.getHeaders(),
        capturedRequestBody: completion.requestBody,
        capturedResponseBody: completion,
      });
    })
    .catch((error: unknown) => {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
    });
  return { observation, requestContext: started.requestContext };
}

function warnIfMiddlewareAlreadyRegistered(app: Koa): void {
  try {
    if (app.middleware.length > 0) {
      logWarning(
        "useApitally() was called after middleware was registered on the Koa app, so earlier middleware may handle or consume requests before Apitally observes them. To resolve this, call useApitally() immediately after creating the app, before registering middleware and routes.",
      );
    }
  } catch (error) {
    logDebug(`Error inspecting the koa app's middleware: ${String(error)}`);
  }
}
