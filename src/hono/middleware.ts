import { type Context, context } from "@opentelemetry/api";
import type { Hono, Context as HonoContext, MiddlewareHandler } from "hono";
import { activate, isActivated } from "../activation.js";
import { getConfig } from "../config.js";
import { getRequestRecord, type RequestRecord } from "../context.js";
import { captureException } from "../exceptions.js";
import { logDebug, logWarning } from "../logger.js";
import {
  finalizeRequestObservation,
  finalizeRequestObservationWithError,
} from "../requestObservation.js";
import {
  captureWebResponse,
  isWebSocketUpgrade,
  startWebRequestObservation,
  type WebRequestObservation,
  type WebResponseCompletion,
} from "../requestObservationWeb.js";
import {
  extractZodValidationErrors,
  isValidationResponseStatus,
  parseJsonResponseBody,
} from "../validationErrors.js";
import { resolveMatchedRoute } from "./routes.js";

const FETCH_WRAP_MARKER = Symbol.for("apitally.honoFetchWrap");
const ERROR_HANDLER_WRAP_MARKER = Symbol.for("apitally.honoErrorHandlerWrap");
const TRACER_NAME = "apitally.hono";

type FetchFunction = (request: Request, ...rest: unknown[]) => Response | Promise<Response>;

interface RequestObservation extends WebRequestObservation {
  honoContext?: HonoContext;
  route?: string;
}

// WeakMap associates route middleware with transport observation without
// retaining completed request records.
const observationsByRequestRecord = new WeakMap<RequestRecord, RequestObservation>();

// Wrapping app.fetch covers every response, including onError. Route middleware
// precedes later registrations, and the marker prevents duplicate observation.
export function wrapAppFetch(app: Hono): void {
  const markedApp = app as unknown as Record<symbol, boolean | undefined>;
  if (markedApp[FETCH_WRAP_MARKER] === true) {
    return;
  }
  if (hasRegisteredRoutes(app)) {
    logWarning(
      "useApitally() was called after routes were registered on the Hono app, so Apitally was not installed. To resolve this, call useApitally() immediately after creating the app, before registering routes.",
    );
    return;
  }
  markedApp[FETCH_WRAP_MARKER] = true;
  app.use(recordMatchedRouteAfterNext);
  const originalFetch = app.fetch as FetchFunction;
  let errorHandlerWrapPending = true;
  // First-request wrapping follows route() mounts and onError registration.
  // Replacing the handler afterward disables exception capture.
  const wrapErrorHandlerOnce = () => {
    if (errorHandlerWrapPending) {
      errorHandlerWrapPending = false;
      wrapErrorHandler(app);
    }
  };
  const wrappedFetch: FetchFunction = function (
    this: unknown,
    request: Request,
    ...rest: unknown[]
  ) {
    let observed: ObservedRequestStart | undefined;
    try {
      observed = observeRequest(request, rest[0], wrapErrorHandlerOnce);
    } catch (error) {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
    }
    if (!observed) {
      return originalFetch.call(this, request, ...rest);
    }
    const { observation, requestContext } = observed;
    let dispatchResult: Response | Promise<Response>;
    try {
      dispatchResult = context.with(requestContext, () =>
        originalFetch.call(this, request, ...rest),
      );
    } catch (error) {
      finalizeRequestObservationAfterFetchRejection(observation, error);
      throw error;
    }
    return Promise.resolve(dispatchResult).then(
      (response) => observeResponse(response, observation),
      (error: unknown) => {
        finalizeRequestObservationAfterFetchRejection(observation, error);
        throw error;
      },
    );
  };
  (app as { fetch: FetchFunction }).fetch = wrappedFetch;
}

// Middleware entries register as method "ALL" and lose nothing when they
// precede the wrap; only concrete-method entries need the route middleware
// that is registered after them.
function hasRegisteredRoutes(app: Hono): boolean {
  try {
    const routes = app.routes;
    return (
      Array.isArray(routes) &&
      routes.some((route) => typeof route.method === "string" && route.method !== "ALL")
    );
  } catch (error) {
    logDebug(`Error inspecting the hono app's routes: ${String(error)}`);
    return false;
  }
}

// Registered before later routes, this middleware records the resolved route
// and Hono body cache after next().
const recordMatchedRouteAfterNext: MiddlewareHandler = async (c, next) => {
  const requestRecord = getRequestRecord();
  await next();
  if (!requestRecord) {
    return;
  }
  try {
    const observation = observationsByRequestRecord.get(requestRecord);
    if (observation) {
      observation.honoContext = c;
      observation.route = resolveMatchedRoute(c);
    }
  } catch (error) {
    logDebug(`Error recording the matched hono route: ${String(error)}`);
  }
};

interface ObservedRequestStart {
  observation: RequestObservation;
  requestContext: Context;
}

function observeRequest(
  request: Request,
  env: unknown,
  wrapErrorHandlerOnce: () => void,
): ObservedRequestStart | undefined {
  activate();
  if (!isActivated() || isWebSocketUpgrade(request)) {
    return undefined;
  }
  wrapErrorHandlerOnce();
  const started = startWebRequestObservation({
    request,
    tracerName: TRACER_NAME,
    clientAddress: resolveNodeServerClientAddress(env),
  });
  const observation: RequestObservation = started.observation;
  observationsByRequestRecord.set(observation.requestRecord, observation);
  return { observation, requestContext: started.requestContext };
}

// A tee after compression observes bytes sent to the client. Finalization follows
// tee completion, and bodiless responses complete immediately.
function observeResponse(response: Response, observation: RequestObservation): Response {
  try {
    const captured = captureWebResponse(
      response,
      (getConfig().captureResponseBody && observation.requestRecord.dropReason === undefined) ||
        isValidationResponseStatus(response.status),
    );
    captured.completion
      .then((completion) => finalizeRequestFromResponse(observation, response, completion))
      .catch((error: unknown) => {
        logWarning(`Error in the Apitally middleware: ${String(error)}`);
      });
    return captured.response;
  } catch (error) {
    logWarning(`Error in the Apitally middleware: ${String(error)}`);
    return response;
  }
}

async function finalizeRequestFromResponse(
  observation: RequestObservation,
  response: Response,
  capturedResponseBody: WebResponseCompletion,
): Promise<void> {
  await captureRequestBodyFromCache(observation);
  if (isValidationResponseStatus(response.status)) {
    observation.requestRecord.validationErrors ??= extractZodValidationErrors(
      parseJsonResponseBody(capturedResponseBody.body, response.headers.get("content-encoding")),
    );
  }
  finalizeRequestObservation({
    observation,
    completedAtMillis: capturedResponseBody.completedAtMillis,
    statusCode: response.status,
    route: observation.route,
    requestHeaders: observation.requestHeaders,
    responseHeaders: response.headers,
    capturedRequestBody: observation.requestBodyCapture,
    capturedResponseBody,
  });
}

// A fetch rejection has no response, so the request record is finalized and
// the rejection propagates unchanged.
function finalizeRequestObservationAfterFetchRejection(
  observation: RequestObservation,
  error: unknown,
): void {
  try {
    finalizeRequestObservationWithError({
      requestRecord: observation.requestRecord,
      spanHandle: observation.spanHandle,
      error,
      durationSeconds: (performance.now() - observation.startTimeMillis) / 1000,
    });
  } catch (finalizeError) {
    logWarning(`Error in the Apitally middleware: ${String(finalizeError)}`);
  }
}

// Only cache entries preserving the original request bytes are captured. If no
// such entry exists, the SDK leaves the request stream untouched.
async function captureRequestBodyFromCache(observation: RequestObservation): Promise<void> {
  const bodyCache = observation.honoContext?.req.bodyCache as Record<string, unknown> | undefined;
  if (typeof bodyCache !== "object" || bodyCache === null) {
    return;
  }
  try {
    const chunk = await resolveCachedBodyChunk(bodyCache);
    if (chunk !== undefined) {
      observation.requestBodyCapture.addChunk(chunk);
      observation.requestBodyCapture.markComplete();
    }
  } catch (error) {
    logDebug(`Error reading the hono request body cache: ${String(error)}`);
  }
}

async function resolveCachedBodyChunk(
  bodyCache: Record<string, unknown>,
): Promise<Uint8Array | string | undefined> {
  if (bodyCache.arrayBuffer !== undefined) {
    const value: unknown = await bodyCache.arrayBuffer;
    return value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
  }
  if (bodyCache.text !== undefined) {
    const value: unknown = await bodyCache.text;
    return typeof value === "string" ? value : undefined;
  }
  if (bodyCache.blob !== undefined) {
    const value: unknown = await bodyCache.blob;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Blob).arrayBuffer === "function"
    ) {
      return new Uint8Array(await (value as Blob).arrayBuffer());
    }
  }
  return undefined;
}

// Hono exposes errorHandler at runtime; wrapping it records the exception before
// Hono converts it into a response.
function wrapErrorHandler(app: Hono): void {
  try {
    const appWithHandler = app as unknown as { errorHandler?: unknown };
    const originalHandler = appWithHandler.errorHandler;
    if (typeof originalHandler !== "function") {
      return;
    }
    const markedHandler = originalHandler as unknown as Record<symbol, boolean | undefined>;
    if (markedHandler[ERROR_HANDLER_WRAP_MARKER] === true) {
      return;
    }
    const wrappedHandler = function (this: unknown, ...args: unknown[]) {
      const result = (originalHandler as (...handlerArgs: unknown[]) => unknown).apply(this, args);
      if (result instanceof Promise) {
        return result.then((response) => {
          captureExceptionIfServerErrorResponse(args[0], response);
          return response;
        });
      }
      captureExceptionIfServerErrorResponse(args[0], result);
      return result;
    };
    (wrappedHandler as unknown as Record<symbol, boolean>)[ERROR_HANDLER_WRAP_MARKER] = true;
    appWithHandler.errorHandler = wrappedHandler;
  } catch (error) {
    logDebug(`Error wrapping the hono onError handler: ${String(error)}`);
  }
}

function captureExceptionIfServerErrorResponse(error: unknown, response: unknown): void {
  const status =
    typeof response === "object" && response !== null
      ? (response as { status?: unknown }).status
      : undefined;
  if (typeof status !== "number" || status >= 500) {
    captureException(error);
  }
}

// @hono/node-server passes the Node request as env.incoming; runtimes without
// that shape expose no client address and the attribute is omitted.
function resolveNodeServerClientAddress(env: unknown): string | undefined {
  const incoming = (env as { incoming?: unknown } | undefined | null)?.incoming;
  const socket = (incoming as { socket?: unknown } | undefined | null)?.socket;
  const remoteAddress = (socket as { remoteAddress?: unknown } | undefined | null)?.remoteAddress;
  return typeof remoteAddress === "string" ? remoteAddress : undefined;
}
