import {
  type Attributes,
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  trace,
} from "@opentelemetry/api";
import {
  getRPCMetadata,
  type RPCMetadata,
  RPCType,
  setRPCMetadata,
} from "@opentelemetry/core";
import type { Hono, Context as HonoContext, MiddlewareHandler } from "hono";
import { activate, isActivated } from "../activation.js";
import {
  BodyCapture,
  type CapturedBody,
  captureResponse,
  normalizeHeaders,
} from "../capture.js";
import { type ApitallyConfig, getConfig } from "../config.js";
import {
  CONSUMER_HOLDER_KEY,
  type ConsumerHolder,
  getConsumerHolder,
  getRequestRecord,
  REQUEST_RECORD_KEY,
  type RequestRecord,
  SPAN_HANDLE_KEY,
  type SpanHandle,
} from "../context.js";
import { logDebug, logWarning } from "../logger.js";
import {
  captureException,
  coerceToException,
  getActiveSpanPipeline,
  type RequestStash,
  writeRequestAttribute,
} from "../spanProcessor.js";
import { type MatchedRouteResult, resolveMatchedRoute } from "./routes.js";

const FETCH_WRAP_MARKER = Symbol.for("apitally.honoFetchWrap");
const ERROR_HANDLER_WRAP_MARKER = Symbol.for("apitally.honoErrorHandlerWrap");
const TRACER_NAME = "apitally.hono";

type FetchFunction = (
  request: Request,
  ...rest: unknown[]
) => Response | Promise<Response>;

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

// The route-recording middleware and the transport completion path share the
// per-request observation through the record installed into the request context.
const observationsByRecord = new WeakMap<RequestRecord, RequestObservation>();

const WEB_HEADERS_GETTER: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};

// Wraps app.fetch, the single entry point every request passes through
// (onError-synthesized responses included), and registers the route-recording
// middleware ahead of the routes registered after setup. Wrapping is
// check-and-mark, so a second call through any module copy never observes a
// request twice.
export function wrapAppFetch(app: Hono): void {
  const markedApp = app as unknown as Record<symbol, boolean | undefined>;
  if (markedApp[FETCH_WRAP_MARKER] === true) {
    return;
  }
  markedApp[FETCH_WRAP_MARKER] = true;
  warnIfRoutesWereRegisteredBeforeSetup(app);
  app.use(recordMatchedRouteAfterNext);
  const originalFetch = app.fetch as FetchFunction;
  let errorHandlerWrapPending = true;
  // Wrapped on the first request, so it sits after route() mounting and any
  // user onError registration; a handler replaced after the first request
  // loses exception capture.
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
      observed = observeRequest(request, wrapErrorHandlerOnce);
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

// Runs for every request from the position useApitally registered it, so the
// routes registered after setup compose behind it; after next() the matched
// route and the Hono context (for the request body cache) are recorded onto
// the observation.
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

// Sets up everything request-scoped before the app dispatches: the SERVER span
// (own or adopted) and the context holders. Returns undefined when the request
// is served without telemetry.
function observeRequest(
  request: Request,
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
  const startAttributes = resolveStartAttributes(
    request,
    method,
    requestBodyCapture,
  );
  // Metrics and the exported span copy read from the record, so the start
  // attributes are mirrored into it on every path, span or no span.
  Object.assign(record.attributes, startAttributes);

  const activeSpan = trace.getSpan(activeContext);
  let requestContext: Context;
  let ownSpan: Span | undefined;
  if (activeSpan?.isRecording() && isServerSpan(activeSpan)) {
    // A SERVER span produced by the user's own instrumentation is adopted:
    // no second span, and the request runs under the user's context.
    spanHandle.span = activeSpan;
    record.serverSpanId = activeSpan.spanContext().spanId;
    requestContext = withRequestHolders(
      activeContext,
      spanHandle,
      record,
      consumerHolder,
    );
  } else if (activeSpan && !activeSpan.isRecording()) {
    warnAboutNonRecordingServerSpan();
    requestContext = withRequestHolders(
      activeContext,
      spanHandle,
      record,
      consumerHolder,
    );
  } else {
    const extractedContext = propagation.extract(
      ROOT_CONTEXT,
      request.headers,
      WEB_HEADERS_GETTER,
    );
    requestContext = withRequestHolders(
      extractedContext,
      spanHandle,
      record,
      consumerHolder,
    );
    ownSpan = trace
      .getTracer(TRACER_NAME)
      .startSpan(
        method,
        { kind: SpanKind.SERVER, attributes: startAttributes },
        requestContext,
      );
    if (!ownSpan.isRecording()) {
      warnAboutNonRecordingServerSpan();
      ownSpan = undefined;
    } else {
      spanHandle.span = ownSpan;
      requestContext = trace.setSpan(requestContext, ownSpan);
    }
  }

  // The RPC metadata is the transport-span beacon middleware-based span
  // producers demote on; the route is written onto it at completion.
  let rpcMetadata = getRPCMetadata(requestContext);
  if (!rpcMetadata && spanHandle.span) {
    rpcMetadata = { type: RPCType.HTTP, span: spanHandle.span };
    requestContext = setRPCMetadata(requestContext, rpcMetadata);
  }

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

// The tee wraps the Response the app returned, after any compress middleware,
// so the SDK observes the bytes that cross the wire; the caller receives the
// replacement Response and transport completion follows the tee's completion
// promise, which settles immediately for bodiless responses.
function observeResponse(
  response: Response,
  observation: RequestObservation,
): Response {
  try {
    const [teedResponse, capturedBodyPromise] = captureResponse(
      response,
      observation.config.captureResponseBody,
    );
    capturedBodyPromise
      .then((capturedBody) =>
        finalizeRecordAndReleaseRequest(observation, response, capturedBody),
      )
      .catch((error: unknown) => {
        logWarning(`Error in the Apitally middleware: ${String(error)}`);
      });
    return teedResponse;
  } catch (error) {
    logWarning(`Error in the Apitally middleware: ${String(error)}`);
    return response;
  }
}

async function finalizeRecordAndReleaseRequest(
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
  record.durationSeconds = (performance.now() - startTimeMillis) / 1000;
  await captureRequestBodyFromCache(observation);
  const span = spanHandle.span;
  writeRequestAttribute(
    span,
    record,
    "http.response.status_code",
    response.status,
  );
  const requestBodySize = requestBodyCapture.size;
  if (requestBodySize !== undefined) {
    writeRequestAttribute(
      span,
      record,
      "http.request.body.size",
      requestBodySize,
    );
  }
  const responseBodySize = capturedBody.size;
  if (responseBodySize !== undefined) {
    writeRequestAttribute(
      span,
      record,
      "http.response.body.size",
      responseBodySize,
    );
  }
  const matchedRoute = observation.matchedRoute;
  if (matchedRoute?.route !== undefined) {
    writeRequestAttribute(span, record, "http.route", matchedRoute.route);
    if (rpcMetadata) {
      rpcMetadata.route = matchedRoute.route;
    }
    if (ownSpan?.isRecording()) {
      ownSpan.updateName(`${method} ${matchedRoute.route}`);
    }
  } else {
    // An empty route on the record clears a wrong route a producing
    // instrumentation may have set; the histograms skip empty routes.
    record.attributes["http.route"] = "";
  }
  if (ownSpan && response.status >= 500) {
    ownSpan.setStatus({ code: SpanStatusCode.ERROR });
  }
  if (record.serverSpanId !== undefined) {
    const stash: RequestStash = {};
    if (config.captureRequestHeaders) {
      stash.requestHeaders = normalizeHeaders(observation.requestHeaders);
    }
    if (config.captureResponseHeaders) {
      stash.responseHeaders = normalizeHeaders(response.headers);
    }
    const requestBody = requestBodyCapture.body;
    if (requestBody) {
      stash.requestBody = requestBody;
    }
    const responseBody = capturedBody.body;
    if (responseBody) {
      stash.responseBody = responseBody;
    }
    if (Object.keys(stash).length > 0) {
      getActiveSpanPipeline()?.updateStash(record.serverSpanId, stash);
    }
  }
  ownSpan?.end();
  getActiveSpanPipeline()?.handleTransportCompletion(record);
}

// A rejected dispatch means Hono rethrew a non-Error value or the error
// handler itself failed: the record is finalized without a response and the
// rejection propagates to the caller unchanged.
function releaseRequestOnFetchRejection(
  observation: RequestObservation,
  error: unknown,
): void {
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

// Reads Hono's request body cache at transport completion. Only byte-faithful
// entries are captured (c.req.json() reads through the text entry); parsedBody
// and formData entries would re-serialize into bytes that never crossed the
// wire and are skipped. An empty cache means the app never read the body, and
// the SDK never calls request body methods or touches the request stream.
async function captureRequestBodyFromCache(
  observation: RequestObservation,
): Promise<void> {
  const bodyCache = observation.honoContext?.req.bodyCache as
    | Record<string, unknown>
    | undefined;
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
    // A rejected cache entry means the body read failed; nothing is captured
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

// The errorHandler property is runtime-accessible by design in Hono; wrapping
// it records the exception event on the SERVER span before the app's handler
// (or Hono's default) converts the error into a response.
function wrapErrorHandler(app: Hono): void {
  try {
    const appWithHandler = app as unknown as { errorHandler?: unknown };
    const originalHandler = appWithHandler.errorHandler;
    if (typeof originalHandler !== "function") {
      return;
    }
    const markedHandler = originalHandler as unknown as Record<
      symbol,
      boolean | undefined
    >;
    if (markedHandler[ERROR_HANDLER_WRAP_MARKER] === true) {
      return;
    }
    const wrappedHandler = function (this: unknown, ...args: unknown[]) {
      captureException(args[0]);
      return (originalHandler as (...handlerArgs: unknown[]) => unknown).apply(
        this,
        args,
      );
    };
    (wrappedHandler as unknown as Record<symbol, boolean>)[
      ERROR_HANDLER_WRAP_MARKER
    ] = true;
    appWithHandler.errorHandler = wrappedHandler;
  } catch (error) {
    logDebug(`Error wrapping the hono onError handler: ${String(error)}`);
  }
}

function warnIfRoutesWereRegisteredBeforeSetup(app: Hono): void {
  try {
    if (Array.isArray(app.routes) && app.routes.length > 0) {
      logWarning(
        "useApitally() was called after routes or middleware were registered on the Hono app, so requests handled by those earlier registrations are exported without a route template and are not counted in the request metrics. To resolve this, call useApitally() immediately after creating the app, before registering middleware and routes.",
      );
    }
  } catch (error) {
    logDebug(`Error inspecting the hono app's routes: ${String(error)}`);
  }
}

function resolveStartAttributes(
  request: Request,
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
    // An unparseable request URL leaves only the method attribute
  }
  const userAgent = request.headers.get("user-agent");
  if (userAgent !== null) {
    attributes["user_agent.original"] = userAgent;
  }
  // The trusted Content-Length, when present; the final size is written at
  // completion from the body cache's byte count otherwise
  const requestBodySize = requestBodyCapture.size;
  if (requestBodySize !== undefined) {
    attributes["http.request.body.size"] = requestBodySize;
  }
  return attributes;
}

function withRequestHolders(
  baseContext: Context,
  spanHandle: SpanHandle,
  record: RequestRecord,
  consumerHolder: ConsumerHolder,
): Context {
  return baseContext
    .setValue(SPAN_HANDLE_KEY, spanHandle)
    .setValue(REQUEST_RECORD_KEY, record)
    .setValue(CONSUMER_HOLDER_KEY, consumerHolder);
}

// The active span's kind is not part of the OpenTelemetry API surface, so the
// SDK-level property is read from whichever package copy produced the span.
function isServerSpan(span: Span): boolean {
  return (span as { kind?: unknown }).kind === SpanKind.SERVER;
}

function warnAboutNonRecordingServerSpan(): void {
  logWarning(
    "A request arrived under a SERVER span that the OpenTelemetry sampler did not sample, so only sampled requests reach Apitally as traces and request logs. Request metrics include all requests.",
  );
}
