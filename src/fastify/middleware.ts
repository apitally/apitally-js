import { context } from "@opentelemetry/api";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { activate, flushTelemetry, isActivated } from "../activation.js";
import { getConfig } from "../config.js";
import { captureException } from "../exceptions.js";
import { logWarning } from "../logger.js";
import { finalizeRequestObservation } from "../requestObservation.js";
import {
  captureNodeResponse,
  type StartedNodeRequestObservation,
  startNodeRequestObservation,
} from "../requestObservationNode.js";
import type { RoutePath } from "../startup.js";
import { formatIssues, normalizeSource } from "../validationErrors.js";
import { addStartupPaths, resolveRequestRoute } from "./routes.js";

const HOOKS_MARKER = Symbol.for("apitally.fastifyHooks");
const TRACER_NAME = "apitally.fastify";

export function installFastifyHooks(app: FastifyInstance, startupPaths: RoutePath[]): void {
  const markedApp = app as unknown as Record<symbol, boolean | undefined>;
  if (markedApp[HOOKS_MARKER] === true) {
    return;
  }
  markedApp[HOOKS_MARKER] = true;
  const observations = new WeakMap<FastifyRequest, StartedNodeRequestObservation>();

  app.addHook("onRoute", (routeOptions) => {
    addStartupPaths(startupPaths, routeOptions);
  });
  app.addHook("onReady", (done) => {
    activate();
    done();
  });
  app.addHook("onRequest", (request, reply, done) => {
    activate();
    if (!isActivated() || request.raw.headers.upgrade?.toLowerCase() === "websocket") {
      done();
      return;
    }

    try {
      const state = startNodeRequestObservation({
        request: request.raw,
        tracerName: TRACER_NAME,
      });
      observations.set(request, state);
      captureNodeResponse(
        reply.raw,
        getConfig().captureResponseBody && state.observation.requestRecord.dropReason === undefined,
        state.observation.requestBodyCapture,
        (name) => reply.getHeader(name),
      )
        .then((completion) => {
          try {
            finalizeRequestObservation({
              observation: state.observation,
              completedAtMillis: completion.completedAtMillis,
              statusCode: reply.statusCode,
              route: resolveRequestRoute(request),
              clientAddress: request.ip,
              requestHeaders: request.raw.headers,
              responseHeaders: reply.getHeaders(),
              capturedRequestBody: completion.requestBody,
              capturedResponseBody: completion,
            });
          } finally {
            observations.delete(request);
          }
        })
        .catch((error: unknown) => {
          logWarning(`Error in the Apitally middleware: ${String(error)}`);
        });
      context.with(state.requestContext, done);
    } catch (error) {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
      done();
    }
  });
  app.addHook("preValidation", (request, _reply, done) => {
    const state = observations.get(request);
    if (state) {
      context.with(state.requestContext, done);
    } else {
      done();
    }
  });
  app.addHook("onError", (request, _reply, error, done) => {
    const state = observations.get(request);
    if (!state) {
      done();
      return;
    }
    context.with(state.requestContext, () => {
      const { statusCode, validation, validationContext } = error as {
        statusCode?: unknown;
        validation?: unknown;
        validationContext?: unknown;
      };
      if (typeof statusCode !== "number" || statusCode >= 500) {
        captureException(error);
      }
      if (Array.isArray(validation)) {
        state.observation.requestRecord.validationErrors = formatAjvErrors(
          validation,
          normalizeSource(validationContext),
        );
      }
      done();
    });
  });
  app.addHook("onClose", () => flushTelemetry());
}

function formatAjvErrors(errors: unknown[], source: string) {
  return formatIssues(
    errors.map((error) => {
      const { instancePath, keyword, params, message } = error as {
        instancePath?: unknown;
        keyword?: unknown;
        params?: { missingProperty?: unknown };
        message?: unknown;
      };
      // AJV returns instancePath as a JSON Pointer but missingProperty as a raw property name.
      const missing =
        typeof params?.missingProperty === "string"
          ? `/${params.missingProperty.replace(/~/g, "~0").replace(/\//g, "~1")}`
          : "";
      return { path: `${instancePath ?? ""}${missing}`, message, code: keyword };
    }),
    source,
  );
}
