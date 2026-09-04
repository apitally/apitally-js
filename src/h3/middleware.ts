import { context } from "@opentelemetry/api";
import type { H3 } from "h3";
import { activate, isActivated } from "../activation.js";
import { getConfig } from "../config.js";
import { getRequestRecord } from "../context.js";
import { captureException } from "../exceptions.js";
import { logDebug, logWarning } from "../logger.js";
import {
  finalizeRequestObservation,
  finalizeRequestObservationWithError,
} from "../requestObservation.js";
import {
  captureWebRequestBody,
  captureWebResponse,
  isWebSocketUpgrade,
  startWebRequestObservation,
  type WebRequestObservation,
} from "../requestObservationWeb.js";
import { formatIssues } from "../validationErrors.js";
import { resolveMatchedRoute } from "./routes.js";

const TRACER_NAME = "apitally.h3";

type H3RequestFunction = H3["~request"];
type H3Request = Parameters<H3RequestFunction>[0];

interface H3RequestObservation extends WebRequestObservation {
  requestBodyCompletion: Promise<void>;
  route?: string;
}

export function installH3RequestObservation(app: H3): void {
  const appInternals = app as unknown as { "~request"?: unknown };
  const originalRequest = appInternals["~request"];
  if (typeof originalRequest !== "function") {
    logWarning(
      "The H3 request dispatcher is unavailable, so Apitally request instrumentation is disabled.",
    );
    return;
  }

  const observations = new WeakMap<object, H3RequestObservation>();
  const requestFunction = originalRequest as H3RequestFunction;
  const originalOnError = app.config.onError;
  const wrappedRequest: H3RequestFunction = function (this: H3, request, requestContext) {
    if (getRequestRecord()) {
      return requestFunction.call(this, request, requestContext);
    }

    let observation: H3RequestObservation;
    let observationContext: ReturnType<typeof startWebRequestObservation>["requestContext"];
    try {
      activate();
      if (!isActivated() || isWebSocketUpgrade(request)) {
        return requestFunction.call(this, request, requestContext);
      }
      const requestAddress = (request as { context?: { clientAddress?: unknown } }).context
        ?.clientAddress;
      const clientAddress = requestContext?.clientAddress;
      const started = startWebRequestObservation({
        request,
        tracerName: TRACER_NAME,
        clientAddress:
          typeof clientAddress === "string"
            ? clientAddress
            : typeof requestAddress === "string"
              ? requestAddress
              : undefined,
      });
      observation = {
        ...started.observation,
        requestBodyCompletion: captureWebRequestBody(
          request,
          started.observation.requestBodyCapture,
        ),
      };
      observationContext = started.requestContext;
      observations.set(request, observation);
    } catch (error) {
      logWarning(`Error in the Apitally H3 middleware: ${String(error)}`);
      return requestFunction.call(this, request, requestContext);
    }

    let result: Response | Promise<Response>;
    try {
      result = context.with(observationContext, () =>
        requestFunction.call(this, request, requestContext),
      );
    } catch (error) {
      finalizeFailedRequestObservation(observations, request, error);
      throw error;
    }
    if (typeof (result as PromiseLike<Response>)?.then === "function") {
      return Promise.resolve(result).then(
        (response) => observeResponse(observations, request, response),
        (error: unknown) => {
          finalizeFailedRequestObservation(observations, request, error);
          throw error;
        },
      );
    }
    return observeResponse(observations, request, result as Response);
  };

  try {
    app.config.onError = (error, event) => {
      let status: number | undefined;
      if (typeof error === "number") {
        status = error;
      } else if (typeof error === "object" && error !== null) {
        const candidate = error as { status?: unknown; statusCode?: unknown };
        status =
          typeof candidate.status === "number"
            ? candidate.status
            : typeof candidate.statusCode === "number"
              ? candidate.statusCode
              : undefined;
      }
      try {
        if (status === undefined || status >= 500) {
          const cause =
            typeof error === "object" && error !== null
              ? (error as { cause?: unknown }).cause
              : undefined;
          captureException(cause === undefined ? error : cause);
        }
        const issues = (error as { data?: { issues?: unknown } } | undefined)?.data?.issues;
        const requestRecord = getRequestRecord();
        if (requestRecord && Array.isArray(issues)) {
          requestRecord.validationErrors = formatIssues(issues);
        }
      } catch (captureError) {
        logDebug(`Error recording an H3 exception: ${String(captureError)}`);
      }
      return originalOnError?.(error, event);
    };
    appInternals["~request"] = wrappedRequest;
    app.use((event, next) => {
      const observation = observations.get(event.req);
      if (observation) {
        observation.route = resolveMatchedRoute(event);
      }
      return next();
    });
  } catch (error) {
    try {
      app.config.onError = originalOnError;
      appInternals["~request"] = originalRequest;
    } catch {
      // H3 may have frozen the app before setup was attempted.
    }
    logWarning(`Error installing the Apitally H3 middleware: ${String(error)}`);
  }
}

function observeResponse(
  observations: WeakMap<object, H3RequestObservation>,
  request: H3Request,
  response: Response,
): Response {
  const observation = observations.get(request);
  if (!observation) {
    return response;
  }
  observations.delete(request);
  const statusCode = response.status;
  let responseHeaders = response.headers;
  try {
    responseHeaders = new Headers(response.headers);
    const captured = captureWebResponse(
      response,
      getConfig().captureResponseBody && observation.requestRecord.dropReason === undefined,
    );
    captured.completion
      .then(async (completion) => {
        await observation.requestBodyCompletion;
        finalizeRequestObservation({
          observation,
          completedAtMillis: completion.completedAtMillis,
          statusCode,
          route: observation.route,
          requestHeaders: observation.requestHeaders,
          responseHeaders,
          capturedRequestBody: observation.requestBodyCapture,
          capturedResponseBody: completion,
        });
      })
      .catch((error: unknown) => {
        logWarning(`Error in the Apitally H3 middleware: ${String(error)}`);
      });
    return captured.response;
  } catch (error) {
    const completedAtMillis = performance.now();
    logWarning(`Error in the Apitally H3 middleware: ${String(error)}`);
    observation.requestBodyCompletion
      .then(() =>
        finalizeRequestObservation({
          observation,
          completedAtMillis,
          statusCode,
          route: observation.route,
          requestHeaders: observation.requestHeaders,
          responseHeaders,
          capturedRequestBody: observation.requestBodyCapture,
        }),
      )
      .catch((completionError: unknown) => {
        logWarning(`Error in the Apitally H3 middleware: ${String(completionError)}`);
      });
    return response;
  }
}

function finalizeFailedRequestObservation(
  observations: WeakMap<object, H3RequestObservation>,
  request: H3Request,
  error: unknown,
): void {
  const observation = observations.get(request);
  if (!observation) {
    return;
  }
  observations.delete(request);
  try {
    finalizeRequestObservationWithError({
      requestRecord: observation.requestRecord,
      spanHandle: observation.spanHandle,
      error,
      durationSeconds: (performance.now() - observation.startTimeMillis) / 1000,
    });
  } catch (finalizeError) {
    logWarning(`Error in the Apitally H3 middleware: ${String(finalizeError)}`);
  }
}
