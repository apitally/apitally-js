import {
  type Attributes,
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  type TextMapGetter,
} from "@opentelemetry/api";
import type { RPCMetadata } from "@opentelemetry/core";
import type { Hono, Context as HonoContext, MiddlewareHandler } from "hono";
import { activate, isActivated } from "../activation.js";
import { BodyCapture, type CapturedBody, captureResponse } from "../capture.js";
import { type ApitallyConfig, getConfig } from "../config.js";
import {
  type ConsumerHolder,
  getConsumerHolder,
  getRequestRecord,
  type RequestRecord,
  type SpanHandle,
} from "../context.js";
import { logDebug, logWarning } from "../logger.js";
import { adoptOrStartServerSpan, finalizeRecordAndReleaseRequest } from "../requestObservation.js";
import { captureException, coerceToException, getActiveSpanPipeline } from "../spanProcessor.js";
import { type MatchedRouteResult, resolveMatchedRoute } from "./routes.js";

const FETCH_WRAP_MARKER = Symbol.for("apitally.honoFetchWrap");
const ERROR_HANDLER_WRAP_MARKER = Symbol.for("apitally.honoErrorHandlerWrap");
const TRACER_NAME = "apitally.hono";

type FetchFunction = (request: Request, ...rest: unknown[]) => Response | Promise<Response>;

interface RequestObservation {
  config: ApitallyConfig;
  record: RequestRecord;
  spanHandle: SpanHandle;
  ownSpan?: Span;
  rpcMetadata?: RPCMetadata;
  requestBodyCapture: BodyCapture;
  requestHeaders: Headers;
  startTimeMillis: number;
  method: string;
  honoContext?: HonoContext;
  matchedRoute?: MatchedRouteResult;
}

// WeakMap associates route middleware with transport observation without
// retaining completed request records.
const observationsByRecord = new WeakMap<RequestRecord, RequestObservation>();

const WEB_HEADERS_GETTER: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};

// Wrapping app.fetch covers every response, including onError. Route middleware
// precedes later registrations, and the marker prevents duplicate observation.
export function wrapAppFetch(app: Hono): void {
  const markedApp = app as unknown as Record<symbol, boolean | undefined>;
  if (markedApp[FETCH_WRAP_MARKER] === true) {
    return;
  }
  markedApp[FETCH_WRAP_MARKER] = true;
  try {
    if (Array.isArray(app.routes) && app.routes.length > 0) {
      logWarning(
        "useApitally() was called after routes or middleware were registered on the Hono app, so requests handled by those earlier registrations are exported without a route template and are not counted in the request metrics. To resolve this, call useApitally() immediately after creating the app, before registering middleware and routes.",
      );
    }
  } catch (error) {
    logDebug(`Error inspecting the hono app's routes: ${String(error)}`);
  }
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
      releaseRequestOnFetchRejection(observation, error);
      throw error;
    }
    return Promise.resolve(dispatchResult).then(
      (response) => observeResponse(response, observation),
      (error: unknown) => {
        releaseRequestOnFetchRejection(observation, error);
        throw error;
      },
    );
  };
  (app as { fetch: FetchFunction }).fetch = wrappedFetch;
}

// Registered before later routes, this middleware records the resolved route
// and Hono body cache after next().
const recordMatchedRouteAfterNext: MiddlewareHandler = async (c, next) => {
  const record = getRequestRecord();
  await next();
  if (!record) {
    return;
  }
  try {
    const observation = observationsByRecord.get(record);
    if (observation) {
      observation.honoContext = c;
      observation.matchedRoute = resolveMatchedRoute(c);
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
  if (!isActivated()) {
    return undefined;
  }
  wrapErrorHandlerOnce();
  const config = getConfig();
  const startTimeMillis = performance.now();
  const method = request.method.toUpperCase();
  const record: RequestRecord = { attributes: {} };
  const spanHandle: SpanHandle = {};
  const activeContext = context.active();
  const consumerHolder: ConsumerHolder = getConsumerHolder(activeContext) ?? {};
  const requestBodyCapture = new BodyCapture({
    captureBody: config.captureRequestBody,
    contentType: request.headers.get("content-type"),
    contentLength: request.headers.get("content-length"),
    transferEncoding: request.headers.get("transfer-encoding"),
  });
  const startAttributes = resolveStartAttributes(request, env, method, requestBodyCapture);
  // Metrics and the exported span copy read from the record, so the start
  // attributes are mirrored into it on every path, span or no span.
  Object.assign(record.attributes, startAttributes);

  const { requestContext, ownSpan, rpcMetadata } = adoptOrStartServerSpan({
    activeContext,
    extractedContext: propagation.extract(ROOT_CONTEXT, request.headers, WEB_HEADERS_GETTER),
    tracerName: TRACER_NAME,
    method,
    startAttributes,
    spanHandle,
    record,
    consumerHolder,
  });

  const observation: RequestObservation = {
    config,
    record,
    spanHandle,
    ownSpan,
    rpcMetadata,
    requestBodyCapture,
    requestHeaders: request.headers,
    startTimeMillis,
    method,
  };
  observationsByRecord.set(record, observation);
  return { observation, requestContext };
}

// A tee after compression observes bytes sent to the client. Finalization follows
// tee completion, and bodiless responses complete immediately.
function observeResponse(response: Response, observation: RequestObservation): Response {
  try {
    const [teedResponse, capturedBodyPromise] = captureResponse(
      response,
      observation.config.captureResponseBody,
    );
    capturedBodyPromise
      .then((capturedBody) => finalizeRequestFromResponse(observation, response, capturedBody))
      .catch((error: unknown) => {
        logWarning(`Error in the Apitally middleware: ${String(error)}`);
      });
    return teedResponse;
  } catch (error) {
    logWarning(`Error in the Apitally middleware: ${String(error)}`);
    return response;
  }
}

async function finalizeRequestFromResponse(
  observation: RequestObservation,
  response: Response,
  capturedBody: CapturedBody,
): Promise<void> {
  const {
    config,
    record,
    spanHandle,
    ownSpan,
    rpcMetadata,
    requestBodyCapture,
    startTimeMillis,
    method,
  } = observation;
  const durationSeconds = (performance.now() - startTimeMillis) / 1000;
  await captureRequestBodyFromCache(observation);
  finalizeRecordAndReleaseRequest({
    record,
    spanHandle,
    ownSpan,
    rpcMetadata,
    config,
    method,
    durationSeconds,
    statusCode: response.status,
    route: observation.matchedRoute?.route,
    requestHeaders: observation.requestHeaders,
    responseHeaders: response.headers,
    requestBodySize: requestBodyCapture.size,
    responseBodySize: capturedBody.size,
    requestBody: requestBodyCapture.body,
    responseBody: capturedBody.body,
  });
}

// A rejected dispatch has no response, so the record is finalized and the
// rejection propagates unchanged.
function releaseRequestOnFetchRejection(observation: RequestObservation, error: unknown): void {
  try {
    const { record, spanHandle, ownSpan, startTimeMillis } = observation;
    record.durationSeconds = (performance.now() - startTimeMillis) / 1000;
    const span = spanHandle.span;
    if (span?.isRecording()) {
      span.recordException(coerceToException(error));
    }
    if (ownSpan) {
      ownSpan.setStatus({ code: SpanStatusCode.ERROR });
      ownSpan.end();
    }
    getActiveSpanPipeline()?.handleTransportCompletion(record);
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
    const bytes = await resolveCachedBodyBytes(bodyCache);
    if (bytes) {
      observation.requestBodyCapture.addChunk(bytes);
      observation.requestBodyCapture.markComplete();
    }
  } catch (error) {
    logDebug(`Error reading the hono request body cache: ${String(error)}`);
  }
}

async function resolveCachedBodyBytes(
  bodyCache: Record<string, unknown>,
): Promise<Uint8Array | undefined> {
  if (bodyCache.arrayBuffer !== undefined) {
    const value: unknown = await bodyCache.arrayBuffer;
    return value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
  }
  if (bodyCache.text !== undefined) {
    const value: unknown = await bodyCache.text;
    return typeof value === "string" ? Buffer.from(value) : undefined;
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
      captureException(args[0]);
      return (originalHandler as (...handlerArgs: unknown[]) => unknown).apply(this, args);
    };
    (wrappedHandler as unknown as Record<symbol, boolean>)[ERROR_HANDLER_WRAP_MARKER] = true;
    appWithHandler.errorHandler = wrappedHandler;
  } catch (error) {
    logDebug(`Error wrapping the hono onError handler: ${String(error)}`);
  }
}

function resolveStartAttributes(
  request: Request,
  env: unknown,
  method: string,
  requestBodyCapture: BodyCapture,
): Attributes {
  const attributes: Attributes = { "http.request.method": method };
  try {
    const url = new URL(request.url);
    attributes["url.path"] = url.pathname;
    const query = url.search.replace(/^\?/, "");
    if (query) {
      attributes["url.query"] = query;
    }
    attributes["url.scheme"] = url.protocol.replace(/:$/, "");
    attributes["server.address"] = url.hostname;
    attributes["url.full"] = request.url;
  } catch {
    // An unparseable request URL leaves only the method attribute.
  }
  const clientAddress = resolveNodeServerClientAddress(env);
  if (clientAddress !== undefined) {
    attributes["client.address"] = clientAddress;
  }
  const userAgent = request.headers.get("user-agent");
  if (userAgent !== null) {
    attributes["user_agent.original"] = userAgent;
  }
  // A trusted Content-Length is available immediately; otherwise completion
  // supplies the cached body byte count.
  const requestBodySize = requestBodyCapture.size;
  if (requestBodySize !== undefined) {
    attributes["http.request.body.size"] = requestBodySize;
  }
  return attributes;
}

// @hono/node-server passes the Node request as env.incoming; runtimes without
// that shape expose no client address and the attribute is omitted.
function resolveNodeServerClientAddress(env: unknown): string | undefined {
  const incoming = (env as { incoming?: unknown } | undefined | null)?.incoming;
  const socket = (incoming as { socket?: unknown } | undefined | null)?.socket;
  const remoteAddress = (socket as { remoteAddress?: unknown } | undefined | null)?.remoteAddress;
  return typeof remoteAddress === "string" ? remoteAddress : undefined;
}
