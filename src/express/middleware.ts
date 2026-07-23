import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Attributes,
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  getRPCMetadata,
  type RPCMetadata,
  RPCType,
  setRPCMetadata,
} from "@opentelemetry/core";
import type { Express, NextFunction, Request, Response } from "express";
import { activate, getActivationHandles, isActivated } from "../activation.js";
import { BodyCapture, normalizeHeaders } from "../capture.js";
import { type ApitallyConfig, getConfig } from "../config.js";
import {
  CONSUMER_HOLDER_KEY,
  type ConsumerHolder,
  getConsumerHolder,
  REQUEST_RECORD_KEY,
  type RequestRecord,
  SPAN_HANDLE_KEY,
  type SpanHandle,
} from "../context.js";
import { logDebug, logWarning } from "../logger.js";
import {
  captureException,
  getActiveSpanPipeline,
  type RequestStash,
  writeRequestAttribute,
} from "../spanProcessor.js";
import {
  beginRouteTracking,
  finishRouteTracking,
  warnAboutUncapturedRouteRegistrations,
} from "./routes.js";

const HANDLE_WRAP_MARKER = Symbol.for("apitally.expressHandleWrap");
// A request dispatched through nested wrapped apps is observed by the
// outermost wrap only, so its telemetry is produced exactly once.
const REQUEST_OBSERVED_MARKER = Symbol.for("apitally.expressRequestObserved");
const TRACER_NAME = "apitally.express";

const flushOnCloseServers = new WeakSet<object>();

type HandleFunction = (
  req: IncomingMessage,
  res: ServerResponse,
  callback?: (error?: unknown) => void,
) => unknown;

// Wraps app.handle, the single entry point every request passes through,
// covering unmatched routes and error-handler responses independent of
// middleware position. Wrapping is check-and-mark, so a second call through
// any module copy never observes a request twice.
export function wrapAppHandle(app: Express): void {
  const markedApp = app as unknown as Record<symbol, boolean | undefined>;
  if (markedApp[HANDLE_WRAP_MARKER] === true) {
    return;
  }
  markedApp[HANDLE_WRAP_MARKER] = true;
  const originalHandle = (app as unknown as { handle: HandleFunction }).handle;
  let errorMiddlewareAppended = false;
  const appendErrorMiddlewareOnce = () => {
    if (errorMiddlewareAppended) {
      return;
    }
    errorMiddlewareAppended = true;
    // Appended on the first request so it sits below every handler the app
    // registered at setup; it records the exception and always passes it on.
    app.use(
      (error: unknown, _req: Request, _res: Response, next: NextFunction) => {
        captureException(error);
        next(error);
      },
    );
  };
  (app as unknown as { handle: HandleFunction }).handle = function (
    this: unknown,
    req: IncomingMessage,
    res: ServerResponse,
    callback?: (error?: unknown) => void,
  ): unknown {
    let requestContext: Context | undefined;
    try {
      requestContext = observeRequest(req, res, appendErrorMiddlewareOnce);
    } catch (error) {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
    }
    if (!requestContext) {
      return originalHandle.call(this, req, res, callback);
    }
    return context.with(requestContext, () =>
      originalHandle.call(this, req, res, callback),
    );
  };
}

// Sets up everything request-scoped before the middleware stack runs: the
// SERVER span (own or adopted), the context holders, response and request body
// observation, and route tracking. Returns the context the stack runs under,
// or undefined when the request is served without telemetry.
function observeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  appendErrorMiddlewareOnce: () => void,
): Context | undefined {
  activate();
  if (!isActivated()) {
    return undefined;
  }
  const markedRequest = req as unknown as Record<symbol, boolean | undefined>;
  if (markedRequest[REQUEST_OBSERVED_MARKER] === true) {
    return undefined;
  }
  markedRequest[REQUEST_OBSERVED_MARKER] = true;
  appendErrorMiddlewareOnce();
  attachServerCloseFlush(req);
  const config = getConfig();
  const startTimeMillis = performance.now();
  const method = (req.method ?? "GET").toUpperCase();
  // The URL is captured before express mutates req.url during routing
  const requestUrl = req.url ?? "/";
  const record: RequestRecord = { attributes: {} };
  const spanHandle: SpanHandle = {};
  const activeContext = context.active();
  const consumerHolder: ConsumerHolder = getConsumerHolder(activeContext) ?? {};
  const requestBodyCapture = new BodyCapture({
    captureBody: config.captureRequestBody,
    contentType: req.headers["content-type"],
    contentLength: req.headers["content-length"],
    transferEncoding: req.headers["transfer-encoding"],
  });
  observeRequestBody(req, requestBodyCapture);
  beginRouteTracking(req);
  const startAttributes = resolveStartAttributes(
    req,
    method,
    requestUrl,
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
    const extractedContext = propagation.extract(ROOT_CONTEXT, req.headers);
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

  installResponseObservation({
    req,
    res,
    config,
    record,
    spanHandle,
    ownSpan,
    rpcMetadata,
    requestBodyCapture,
    startTimeMillis,
    method,
    requestUrl,
  });
  return requestContext;
}

interface ResponseObservationOptions {
  req: IncomingMessage;
  res: ServerResponse;
  config: ApitallyConfig;
  record: RequestRecord;
  spanHandle: SpanHandle;
  ownSpan?: Span;
  rpcMetadata?: RPCMetadata;
  requestBodyCapture: BodyCapture;
  startTimeMillis: number;
  method: string;
  requestUrl: string;
}

// The write and end patches are installed before the middleware stack runs, so
// anything a compression middleware layers on top feeds its output through
// them: the SDK always observes the bytes that cross the wire.
function installResponseObservation(options: ResponseObservationOptions): void {
  const { res, config } = options;
  let responseBodyCapture: BodyCapture | undefined;
  // Response headers are settled by the first write, when they are flushed
  const ensureResponseBodyCapture = (): BodyCapture => {
    responseBodyCapture ??= new BodyCapture({
      captureBody: config.captureResponseBody,
      contentType: firstStringValue(res.getHeader("content-type")),
      contentLength: res.getHeader("content-length") as
        | string
        | number
        | string[]
        | undefined,
      transferEncoding: res.getHeader("transfer-encoding") as
        | string
        | string[]
        | undefined,
    });
    return responseBodyCapture;
  };
  const recordResponseChunk = (args: unknown[]): void => {
    try {
      const chunk = args[0];
      if (
        typeof chunk === "string" ||
        Buffer.isBuffer(chunk) ||
        chunk instanceof Uint8Array
      ) {
        ensureResponseBodyCapture().addChunk(
          chunk,
          typeof args[1] === "string" ? (args[1] as BufferEncoding) : undefined,
        );
      }
    } catch (error) {
      logDebug(`Error observing a response chunk: ${String(error)}`);
    }
  };
  const originalWrite = res.write as (...args: unknown[]) => boolean;
  res.write = function (this: ServerResponse, ...args: unknown[]): boolean {
    recordResponseChunk(args);
    return originalWrite.apply(this, args);
  } as typeof res.write;
  const originalEnd = res.end as (...args: unknown[]) => ServerResponse;
  res.end = function (
    this: ServerResponse,
    ...args: unknown[]
  ): ServerResponse {
    recordResponseChunk(args);
    return originalEnd.apply(this, args);
  } as typeof res.end;

  let finalized = false;
  const finalizeRequest = (responseFinished: boolean): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    try {
      finalizeRecordAndReleaseRequest(
        options,
        ensureResponseBodyCapture(),
        responseFinished,
      );
    } catch (error) {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
    }
  };
  res.on("finish", () => finalizeRequest(true));
  // Close without finish means the client aborted mid-response: the record is
  // finalized with what is known and the partial body stays suppressed.
  res.on("close", () => finalizeRequest(false));
}

function finalizeRecordAndReleaseRequest(
  options: ResponseObservationOptions,
  responseBodyCapture: BodyCapture,
  responseFinished: boolean,
): void {
  const {
    req,
    res,
    config,
    record,
    spanHandle,
    ownSpan,
    rpcMetadata,
    requestBodyCapture,
    startTimeMillis,
    method,
    requestUrl,
  } = options;
  record.durationSeconds = (performance.now() - startTimeMillis) / 1000;
  if (responseFinished) {
    responseBodyCapture.markComplete();
  }
  const span = spanHandle.span;
  writeRequestAttribute(
    span,
    record,
    "http.response.status_code",
    res.statusCode,
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
  const responseBodySize = responseBodyCapture.size;
  if (responseBodySize !== undefined) {
    writeRequestAttribute(
      span,
      record,
      "http.response.body.size",
      responseBodySize,
    );
  }
  const routeResult = finishRouteTracking(req, requestUrl.split("?")[0]);
  if (routeResult.route !== undefined) {
    writeRequestAttribute(span, record, "http.route", routeResult.route);
    if (rpcMetadata) {
      rpcMetadata.route = routeResult.route;
    }
    if (ownSpan?.isRecording()) {
      ownSpan.updateName(`${method} ${routeResult.route}`);
    }
  } else {
    // An empty route on the record clears a wrong route a producing
    // instrumentation may have set; the histograms skip empty routes.
    record.attributes["http.route"] = "";
    if (routeResult.matchedUncapturedRegistration) {
      warnAboutUncapturedRouteRegistrations();
    }
  }
  if (ownSpan && res.statusCode >= 500) {
    ownSpan.setStatus({ code: SpanStatusCode.ERROR });
  }
  if (record.serverSpanId !== undefined) {
    const stash: RequestStash = {};
    if (config.captureRequestHeaders) {
      stash.requestHeaders = normalizeHeaders(req.headers);
    }
    if (config.captureResponseHeaders) {
      stash.responseHeaders = normalizeHeaders(res.getHeaders());
    }
    const requestBody = requestBodyCapture.body;
    if (requestBody) {
      stash.requestBody = requestBody;
    }
    const responseBody = responseBodyCapture.body;
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

// The emit wrap observes the request body as it passes through to the app's
// own consumer; the SDK never changes the stream's flow state, so a body no
// consumer reads is never read and never captured.
function observeRequestBody(
  req: IncomingMessage,
  requestBodyCapture: BodyCapture,
): void {
  const originalEmit = req.emit as (...args: unknown[]) => boolean;
  (req as { emit: unknown }).emit = function (
    this: IncomingMessage,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    try {
      if (event === "data") {
        const chunk = args[0];
        if (
          typeof chunk === "string" ||
          Buffer.isBuffer(chunk) ||
          chunk instanceof Uint8Array
        ) {
          requestBodyCapture.addChunk(chunk);
        }
      } else if (event === "end") {
        requestBodyCapture.markComplete();
      }
    } catch (error) {
      logDebug(`Error observing a request body chunk: ${String(error)}`);
    }
    return originalEmit.call(this, event, ...args);
  };
}

// Closing a server triggers a flush of buffered telemetry, never a teardown:
// an app bound to several servers keeps exporting on the still-open ones.
function attachServerCloseFlush(req: IncomingMessage): void {
  const server = (req.socket as { server?: unknown } | undefined)?.server;
  if (
    !server ||
    typeof (server as { on?: unknown }).on !== "function" ||
    flushOnCloseServers.has(server as object)
  ) {
    // Requests dispatched without a live server (serverless-style) skip this
    return;
  }
  flushOnCloseServers.add(server as object);
  (server as { on: (event: string, listener: () => void) => void }).on(
    "close",
    () => {
      const worker = getActivationHandles()?.worker;
      if (worker) {
        worker.runCycle().catch((error: unknown) => {
          logDebug(
            `Error flushing telemetry on server close: ${String(error)}`,
          );
        });
      }
    },
  );
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

function resolveStartAttributes(
  req: IncomingMessage,
  method: string,
  requestUrl: string,
  requestBodyCapture: BodyCapture,
): Attributes {
  const attributes: Attributes = { "http.request.method": method };
  const [path, query] = splitPathAndQuery(requestUrl);
  attributes["url.path"] = path;
  if (query) {
    attributes["url.query"] = query;
  }
  const scheme = (req.socket as { encrypted?: boolean } | undefined)?.encrypted
    ? "https"
    : "http";
  attributes["url.scheme"] = scheme;
  const host = req.headers.host;
  if (host) {
    const hostname = parseHostname(scheme, host);
    if (hostname) {
      attributes["server.address"] = hostname;
    }
    attributes["url.full"] = `${scheme}://${host}${requestUrl}`;
  }
  const clientAddress = req.socket?.remoteAddress;
  if (clientAddress) {
    attributes["client.address"] = clientAddress;
  }
  const userAgent = req.headers["user-agent"];
  if (typeof userAgent === "string") {
    attributes["user_agent.original"] = userAgent;
  }
  // The trusted Content-Length, when present; the final size is written at
  // completion from the observed byte count otherwise
  const requestBodySize = requestBodyCapture.size;
  if (requestBodySize !== undefined) {
    attributes["http.request.body.size"] = requestBodySize;
  }
  return attributes;
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

function splitPathAndQuery(url: string): [string, string | undefined] {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) {
    return [url, undefined];
  }
  return [url.slice(0, queryIndex), url.slice(queryIndex + 1) || undefined];
}

function parseHostname(scheme: string, host: string): string | undefined {
  try {
    return new URL(`${scheme}://${host}`).hostname;
  } catch {
    return undefined;
  }
}

function firstStringValue(
  value: string | number | string[] | undefined,
): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return undefined;
}
