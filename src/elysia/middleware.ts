import { type Context, context } from "@opentelemetry/api";
import type { AnyElysia } from "elysia";
import {
  activate,
  configure,
  flushTelemetry,
  isActivated,
  registerStartupEventInfo,
} from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { getConfig } from "../config.js";
import { captureException } from "../exceptions.js";
import { logDebug, logWarning } from "../logger.js";
import { resolvePackageVersion } from "../packageVersion.js";
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
import { resolveStartupPaths } from "./routes.js";

const INSTALL_MARKER = Symbol.for("apitally.elysiaInstall");
const PLUGIN_NAME = "apitally";
const TRACER_NAME = "apitally.elysia";

interface ElysiaConstructor {
  new (config?: { name?: string }): AnyElysia;
}

type ElysiaDispatcher = (this: unknown, ...args: unknown[]) => Response | Promise<Response>;
type ElysiaWrap = Parameters<AnyElysia["wrap"]>[0];

interface ElysiaRequestObservation extends WebRequestObservation {
  requestContext: Context;
  requestBodyCompletion: Promise<void>;
  route?: string;
  error?: unknown;
}

export function createElysiaPlugin(
  ElysiaClass: ElysiaConstructor,
  options?: ApitallyOptions,
): AnyElysia {
  configure(options);
  let app: AnyElysia | undefined;
  registerStartupEventInfo({
    framework: "elysia",
    frameworkVersion: resolvePackageVersion("elysia"),
    resolvePaths: () => (app ? resolveStartupPaths(app) : []),
  });
  return buildElysiaPlugin(ElysiaClass, (startedApp) => {
    app = startedApp;
  });
}

export function installElysiaIntegration(app: AnyElysia, options?: ApitallyOptions): void {
  configure(options);
  const markedApp = app as unknown as Record<symbol, boolean | undefined>;
  if (markedApp[INSTALL_MARKER] === true) {
    return;
  }
  if (app.routes.length > 0) {
    logWarning(
      "useApitally() was called after routes were registered on the Elysia app, so Apitally was not installed. To resolve this, call useApitally() immediately after creating the app, before registering routes or plugins that contain routes.",
    );
    return;
  }
  markedApp[INSTALL_MARKER] = true;
  registerStartupEventInfo({
    framework: "elysia",
    frameworkVersion: resolvePackageVersion("elysia"),
    resolvePaths: () => resolveStartupPaths(app),
  });
  const ElysiaClass = app.constructor as ElysiaConstructor;
  app.use(buildElysiaPlugin(ElysiaClass));
}

function buildElysiaPlugin(
  ElysiaClass: ElysiaConstructor,
  recordStartedApp?: (app: AnyElysia) => void,
): AnyElysia {
  const observations = new WeakMap<Request, ElysiaRequestObservation>();
  const plugin = new ElysiaClass({ name: PLUGIN_NAME });

  plugin.wrap(
    ((dispatcher: ElysiaDispatcher, request: Request) =>
      function (this: unknown, ...args: unknown[]): Response | Promise<Response> {
        let observation: ElysiaRequestObservation;
        try {
          activate();
          if (!isActivated() || isWebSocketUpgrade(request)) {
            return dispatcher.apply(this, args);
          }
          const started = startWebRequestObservation({
            request,
            tracerName: TRACER_NAME,
          });
          observation = {
            ...started.observation,
            requestContext: started.requestContext,
            requestBodyCompletion: captureWebRequestBody(
              request,
              started.observation.requestBodyCapture,
            ),
          };
          observations.set(request, observation);
        } catch (error) {
          logWarning(`Error in the Apitally Elysia middleware: ${String(error)}`);
          return dispatcher.apply(this, args);
        }

        let result: Response | Promise<Response>;
        try {
          result = context.with(observation.requestContext, () => dispatcher.apply(this, args));
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
      }) as unknown as ElysiaWrap,
  );

  plugin.onStart((app) => {
    recordStartedApp?.(app);
  });
  plugin.onTransform({ as: "global" }, ({ request, route }) => {
    try {
      const observation = observations.get(request);
      if (observation && typeof route === "string" && route.length > 0) {
        observation.route = route;
      }
    } catch (error) {
      logDebug(`Error recording the matched Elysia route: ${String(error)}`);
    }
  });
  plugin.onError({ as: "global" }, ({ request, route, error }) => {
    try {
      const observation = observations.get(request);
      if (!observation) {
        return;
      }
      if (typeof route === "string" && route.length > 0) {
        observation.route = route;
      }
      observation.error = error;
    } catch (hookError) {
      logDebug(`Error recording an Elysia error: ${String(hookError)}`);
    }
  });
  plugin.onStop(() => {
    flushTelemetry().catch((error: unknown) => {
      logWarning(`Error flushing Apitally telemetry: ${String(error)}`);
    });
  });

  return plugin;
}

function observeResponse(
  observations: WeakMap<Request, ElysiaRequestObservation>,
  request: Request,
  response: Response,
): Response {
  const observation = observations.get(request);
  if (!observation) {
    return response;
  }
  observations.delete(request);
  const statusCode = response.status;
  // A non-404 response without a recorded route matched a route registered
  // before the plugin was applied; the plugin cannot detect this at setup.
  if (observation.route === undefined && statusCode !== 404) {
    logWarning(
      "A request matched a route registered before the Apitally plugin was applied, so it is exported without a route template and is not counted in the request metrics. To resolve this, apply the Apitally plugin immediately after creating the app, before registering routes.",
    );
  }
  let responseHeaders = response.headers;
  try {
    responseHeaders = new Headers(response.headers);
    const shouldAddContentType = shouldAddBunErrorContentType(observation, responseHeaders);
    if (shouldAddContentType) {
      responseHeaders.set("content-type", "text/plain;charset=utf-8");
    }
    if (observation.error !== undefined && statusCode >= 500) {
      context.with(observation.requestContext, () => captureException(observation.error));
    }
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
        logWarning(`Error in the Apitally Elysia middleware: ${String(error)}`);
      });
    if (!shouldAddContentType) {
      return captured.response;
    }
    // Bun adds this header after .wrap(); retain it when replacing the body stream.
    return new Response(captured.response.body, {
      status: captured.response.status,
      statusText: captured.response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const completedAtMillis = performance.now();
    logWarning(`Error in the Apitally Elysia middleware: ${String(error)}`);
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
        logWarning(`Error in the Apitally Elysia middleware: ${String(completionError)}`);
      });
    return response;
  }
}

function shouldAddBunErrorContentType(
  observation: ElysiaRequestObservation,
  responseHeaders: Headers,
): boolean {
  if (
    typeof (process.versions as { bun?: unknown }).bun !== "string" ||
    responseHeaders.has("content-type")
  ) {
    return false;
  }
  const errorCode = (observation.error as { code?: unknown } | undefined)?.code;
  return errorCode === "NOT_FOUND" || errorCode === "VALIDATION";
}

function finalizeFailedRequestObservation(
  observations: WeakMap<Request, ElysiaRequestObservation>,
  request: Request,
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
    logWarning(`Error in the Apitally Elysia middleware: ${String(finalizeError)}`);
  }
}
