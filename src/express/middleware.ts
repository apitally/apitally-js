import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Attributes,
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
} from "@opentelemetry/api";
import type { RPCMetadata } from "@opentelemetry/core";
import type { Express, NextFunction, Request, Response } from "express";
import { activate, getActivationHandles, isActivated } from "../activation.js";
import { BodyCapture } from "../capture.js";
import { getConfig } from "../config.js";
import type { RequestRecord, SpanHandle } from "../context.js";
import { logDebug, logWarning } from "../logger.js";
import { finalizeRecordAndReleaseRequest, startRequestObservation } from "../requestObservation.js";
import { captureException } from "../spanProcessor.js";
import { beginRouteTracking, finishRouteTracking } from "./routes.js";

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

// Wrapping app.handle observes unmatched routes and error responses regardless
// of middleware order. The marker prevents duplicate observation.
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
    app.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
      captureException(error);
      next(error);
    });
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
    return context.with(requestContext, () => originalHandle.call(this, req, res, callback));
  };
}

// Request setup precedes Express middleware so span, body, response, and route
// observation share one context.
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
  // The URL is captured before Express mutates req.url during routing.
  const requestUrl = req.url ?? "/";
  const activeContext = context.active();
  const requestBodyCapture = new BodyCapture({
    captureBody: config.captureRequestBody,
    contentType: req.headers["content-type"],
    contentLength: req.headers["content-length"],
    transferEncoding: req.headers["transfer-encoding"],
  });
  observeRequestBody(req, requestBodyCapture);
  beginRouteTracking(req);
  const startAttributes = resolveStartAttributes(req, method, requestUrl, requestBodyCapture);
  const { requestRecord, requestContext, spanHandle, ownSpan, rpcMetadata } =
    startRequestObservation({
      activeContext,
      extractedContext: propagation.extract(ROOT_CONTEXT, req.headers),
      tracerName: TRACER_NAME,
      method,
      startAttributes,
      requestBodyCapture,
    });

  installResponseObservation({
    req,
    res,
    requestRecord,
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
  requestRecord: RequestRecord;
  spanHandle: SpanHandle;
  ownSpan?: Span;
  rpcMetadata?: RPCMetadata;
  requestBodyCapture: BodyCapture;
  startTimeMillis: number;
  method: string;
  requestUrl: string;
}

// Patching write and end before middleware lets compression wrappers feed their
// final wire bytes through capture.
function installResponseObservation(options: ResponseObservationOptions): void {
  const { res, requestRecord } = options;
  const captureResponseBody = getConfig().captureResponseBody;
  let responseBodyCapture: BodyCapture | undefined;
  // Response headers are settled when the first write flushes them.
  const ensureResponseBodyCapture = (): BodyCapture => {
    responseBodyCapture ??= new BodyCapture({
      captureBody: captureResponseBody && requestRecord.dropReason === undefined,
      contentType: firstStringValue(res.getHeader("content-type")),
      contentLength: res.getHeader("content-length") as string | number | string[] | undefined,
      transferEncoding: res.getHeader("transfer-encoding") as string | string[] | undefined,
    });
    return responseBodyCapture;
  };
  const recordResponseChunk = (args: unknown[]): void => {
    try {
      const chunk = args[0];
      if (typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
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
  res.end = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
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
      finalizeRequestFromResponse(options, ensureResponseBodyCapture(), responseFinished);
    } catch (error) {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
    }
  };
  res.on("finish", () => finalizeRequest(true));
  // Close without finish means the client aborted mid-response: the request
  // record is finalized with what is known and the partial body stays suppressed.
  res.on("close", () => finalizeRequest(false));
}

function finalizeRequestFromResponse(
  options: ResponseObservationOptions,
  responseBodyCapture: BodyCapture,
  responseFinished: boolean,
): void {
  const {
    req,
    res,
    requestRecord,
    spanHandle,
    ownSpan,
    rpcMetadata,
    requestBodyCapture,
    startTimeMillis,
    method,
    requestUrl,
  } = options;
  const durationSeconds = (performance.now() - startTimeMillis) / 1000;
  if (responseFinished) {
    responseBodyCapture.markComplete();
  }
  const routeResult = finishRouteTracking(req, requestUrl.split("?")[0]);
  if (routeResult.matchedUncapturedRegistration) {
    logWarning(
      'Some requests matched routes that Apitally did not capture at registration time. These requests are exported without a route template and are not counted in the request metrics. To resolve this, add `import "apitally/express/register";` as the first line of your application\'s entry module.',
    );
  }
  const shouldReadCapturedBodies = requestRecord.dropReason === undefined;
  finalizeRecordAndReleaseRequest({
    requestRecord,
    spanHandle,
    ownSpan,
    rpcMetadata,
    method,
    durationSeconds,
    statusCode: res.statusCode,
    route: routeResult.route,
    requestHeaders: req.headers,
    responseHeaders: res.getHeaders(),
    requestBodySize: requestBodyCapture.size,
    responseBodySize: responseBodyCapture.size,
    requestBody: shouldReadCapturedBodies ? requestBodyCapture.body : undefined,
    responseBody: shouldReadCapturedBodies ? responseBodyCapture.body : undefined,
  });
}

// Wrapping emit observes only bytes delivered to application consumers and does
// not change the stream's flow state.
function observeRequestBody(req: IncomingMessage, requestBodyCapture: BodyCapture): void {
  const originalEmit = req.emit as (...args: unknown[]) => boolean;
  (req as { emit: unknown }).emit = function (
    this: IncomingMessage,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    try {
      if (event === "data") {
        const chunk = args[0];
        if (typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
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
    return;
  }
  flushOnCloseServers.add(server as object);
  (server as { on: (event: string, listener: () => void) => void }).on("close", () => {
    const worker = getActivationHandles()?.worker;
    if (worker) {
      worker.runCycle().catch((error: unknown) => {
        logDebug(`Error flushing telemetry on server close: ${String(error)}`);
      });
    }
  });
}

function resolveStartAttributes(
  req: IncomingMessage,
  method: string,
  requestUrl: string,
  requestBodyCapture: BodyCapture,
): Attributes {
  const attributes: Attributes = { "http.request.method": method };
  const queryIndex = requestUrl.indexOf("?");
  attributes["url.path"] = queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex);
  const query = queryIndex === -1 ? undefined : requestUrl.slice(queryIndex + 1);
  if (query) {
    attributes["url.query"] = query;
  }
  const scheme = (req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http";
  attributes["url.scheme"] = scheme;
  const host = req.headers.host;
  if (host) {
    try {
      attributes["server.address"] = new URL(`${scheme}://${host}`).hostname;
    } catch {
      // An invalid Host header leaves the server address unset.
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
  // A trusted Content-Length is available immediately; otherwise completion
  // supplies the observed byte count.
  const requestBodySize = requestBodyCapture.size;
  if (requestBodySize !== undefined) {
    attributes["http.request.body.size"] = requestBodySize;
  }
  return attributes;
}

function firstStringValue(value: string | number | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return undefined;
}
