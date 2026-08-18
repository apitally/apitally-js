import { format } from "node:util";
import type { Request, RequestEvent, Server } from "@hapi/hapi";
import { context } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { activate, flushTelemetry, getActivationHandles, isActivated } from "../activation.js";
import { getConfig } from "../config.js";
import { captureException } from "../exceptions.js";
import { emitCapturedLogRecord } from "../logCapture.js";
import { logWarning } from "../logger.js";
import { finalizeRequestObservation } from "../requestObservation.js";
import {
  captureNodeResponse,
  type StartedNodeRequestObservation,
  startNodeRequestObservation,
} from "../requestObservationNode.js";
import { resolveRequestRoute } from "./routes.js";

const TRACER_NAME = "apitally.hapi";

const LOG_LEVEL_SEVERITIES: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

type RequestWithLifecycle = Request & {
  _lifecycle?: () => Promise<void>;
};

export function installHapiHooks(server: Server): void {
  const observations = new WeakMap<Request, StartedNodeRequestObservation>();

  server.ext("onRequest", (request, h) => {
    activate();
    if (!isActivated() || request.raw.req.headers.upgrade?.toLowerCase() === "websocket") {
      return h.continue;
    }

    try {
      const state = startNodeRequestObservation({
        request: request.raw.req,
        tracerName: TRACER_NAME,
      });
      observations.set(request, state);
      captureNodeResponse(
        request.raw.res,
        getConfig().captureResponseBody && state.observation.requestRecord.dropReason === undefined,
        state.observation.requestBodyCapture,
      )
        .then((completion) => {
          finalizeRequestObservation({
            observation: state.observation,
            completedAtMillis: completion.completedAtMillis,
            statusCode: request.raw.res.statusCode,
            route: resolveRequestRoute(request),
            requestHeaders: request.raw.req.headers,
            responseHeaders: request.raw.res.getHeaders(),
            capturedRequestBody: completion.requestBody,
            capturedResponseBody: completion,
          });
        })
        .catch((error: unknown) => {
          logWarning(`Error in the Apitally Hapi middleware: ${String(error)}`);
        });

      const requestWithLifecycle = request as RequestWithLifecycle;
      const lifecycle = requestWithLifecycle._lifecycle;
      if (typeof lifecycle === "function") {
        requestWithLifecycle._lifecycle = function (this: RequestWithLifecycle) {
          return context.with(state.requestContext, () => lifecycle.call(this));
        };
      }
    } catch (error) {
      logWarning(`Error in the Apitally Hapi middleware: ${String(error)}`);
    }
    return h.continue;
  });

  server.ext("onPreResponse", (request, h) => {
    const state = observations.get(request);
    if (state) {
      context.with(state.requestContext, () => {
        const statusCode = resolveBoomStatusCode(request.response);
        if (statusCode !== undefined && statusCode >= 500) {
          captureException(request.response);
        }
      });
    }
    return h.continue;
  });

  server.events.on("request", (request, event) => {
    captureRequestLog(server, observations, request, event);
  });
  server.ext("onPostStop", () => flushTelemetry());
  try {
    server.ext("onPreStart", () => {
      activate();
    });
  } catch {
    activate();
  }
}

function captureRequestLog(
  server: Server,
  observations: WeakMap<Request, StartedNodeRequestObservation>,
  request: Request,
  event: RequestEvent,
): void {
  try {
    if (
      event.channel !== "app" ||
      !getConfig().captureLogs ||
      (server.registrations as Record<string, unknown>)["hapi-pino"] !== undefined
    ) {
      return;
    }
    const state = observations.get(request);
    const loggerProvider = getActivationHandles()?.loggerProvider;
    if (!state || !loggerProvider) {
      return;
    }
    const { severityNumber, severityText } = resolveLogSeverity(event.tags);
    context.with(state.requestContext, () => {
      const logger = loggerProvider.getLogger("hapi");
      if (logger.enabled({ severityNumber })) {
        emitCapturedLogRecord(logger, {
          severityNumber,
          severityText,
          body: format(event.error ?? event.data),
          timestamp: Number(event.timestamp),
        });
      }
    });
  } catch {
    // Capture must never throw into request.log().
  }
}

function resolveLogSeverity(tags: string[]): {
  severityNumber: SeverityNumber;
  severityText: string;
} {
  for (const tag of tags) {
    const severityText = tag.toLowerCase();
    const severityNumber = LOG_LEVEL_SEVERITIES[severityText];
    if (severityNumber !== undefined) {
      return { severityNumber, severityText };
    }
  }
  return { severityNumber: SeverityNumber.INFO, severityText: "log" };
}

function resolveBoomStatusCode(response: unknown): number | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const candidate = response as {
    isBoom?: unknown;
    output?: { statusCode?: unknown };
  };
  return candidate.isBoom === true && typeof candidate.output?.statusCode === "number"
    ? candidate.output.statusCode
    : undefined;
}
