import { type Attributes, type Context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { getRPCMetadata, type RPCMetadata, RPCType, setRPCMetadata } from "@opentelemetry/core";
import type { BodyCapture, CapturedBody } from "./bodyCapture.js";
import { getConfig } from "./config.js";
import {
  attachRequestRecordToRpcMetadata,
  getConsumerHolder,
  type RequestRecord,
  type SpanHandle,
  withRequestHolders,
} from "./context.js";
import { coerceToException } from "./exceptions.js";
import { logWarning } from "./logger.js";
import { writeRequestAttribute } from "./requestAttributes.js";
import {
  getActiveSpanPipeline,
  isApitallySpanProcessorDeclared,
  type RequestStash,
} from "./spanProcessor.js";

interface StartRequestObservationOptions {
  activeContext: Context;
  extractedContext: Context;
  tracerName: string;
  method: string;
  startAttributes: Attributes;
  requestBodyCapture: BodyCapture;
}

export interface StartedRequestObservation {
  requestRecord: RequestRecord;
  requestContext: Context;
  spanHandle: SpanHandle;
  rpcMetadata?: RPCMetadata;
}

export interface HttpRequestStartAttributeInput {
  method: string;
  path?: string;
  query?: string;
  scheme?: string;
  serverAddress?: string;
  fullUrl?: string;
  clientAddress?: string;
  userAgent?: string;
  requestBodySize?: number;
}

export function resolveHttpRequestStartAttributes(
  input: HttpRequestStartAttributeInput,
): Attributes {
  const attributes: Attributes = { "http.request.method": input.method };
  const optionalAttributes: [string, string | number | undefined][] = [
    ["url.path", input.path],
    ["url.query", input.query],
    ["url.scheme", input.scheme],
    ["server.address", input.serverAddress],
    ["url.full", input.fullUrl],
    ["client.address", input.clientAddress],
    ["user_agent.original", input.userAgent],
    ["http.request.body.size", input.requestBodySize],
  ];
  for (const [name, value] of optionalAttributes) {
    if (value !== undefined) {
      attributes[name] = value;
    }
  }
  return attributes;
}

export function startRequestObservation(
  options: StartRequestObservationOptions,
): StartedRequestObservation {
  const {
    activeContext,
    extractedContext,
    tracerName,
    method,
    startAttributes,
    requestBodyCapture,
  } = options;
  const requestRecord: RequestRecord = { attributes: {} };
  const spanHandle: SpanHandle = {};
  const consumerHolder = getConsumerHolder(activeContext) ?? {};
  // Metrics and the exported span copy read from the request record, so the
  // start attributes are mirrored into it on every path, span or no span.
  Object.assign(requestRecord.attributes, startAttributes);
  const activeSpan = trace.getSpan(activeContext);
  let requestContext: Context;
  // Span kind is not part of the OTel API surface, so read the SDK-level
  // property from whichever package copy produced the span.
  if (activeSpan?.isRecording() && (activeSpan as { kind?: unknown }).kind === SpanKind.SERVER) {
    // A SERVER span produced by the user's own instrumentation is adopted:
    // no second span, and the request runs under the user's context.
    spanHandle.span = activeSpan;
    requestRecord.serverSpanId = activeSpan.spanContext().spanId;
    if (getActiveSpanPipeline()?.isRequestInFlight(requestRecord.serverSpanId) !== true) {
      requestRecord.dropReason = "sampled-out";
    }
    requestContext = withRequestHolders(activeContext, spanHandle, requestRecord, consumerHolder);
  } else if (activeSpan && !activeSpan.isRecording()) {
    warnAboutNonRecordingServerSpan();
    requestRecord.dropReason = "sampled-out";
    requestContext = withRequestHolders(activeContext, spanHandle, requestRecord, consumerHolder);
  } else {
    requestContext = withRequestHolders(
      extractedContext,
      spanHandle,
      requestRecord,
      consumerHolder,
    );
    const ownSpan = trace
      .getTracer(tracerName)
      .startSpan(method, { kind: SpanKind.SERVER, attributes: startAttributes }, requestContext);
    if (!ownSpan.isRecording()) {
      warnAboutNonRecordingServerSpan();
      requestRecord.dropReason = "sampled-out";
    } else {
      spanHandle.span = ownSpan;
      spanHandle.ownSpan = ownSpan;
      if (isApitallySpanProcessorDeclared() && requestRecord.serverSpanId === undefined) {
        requestRecord.dropReason = "sampled-out";
        warnAboutUnattachedSpanProcessor();
      }
      requestContext = trace.setSpan(requestContext, ownSpan);
    }
  }

  // Middleware-based span producers inspect OTel RPC metadata to demote duplicate
  // transport spans; completion adds the route.
  let rpcMetadata = getRPCMetadata(requestContext);
  if (!rpcMetadata && spanHandle.span) {
    rpcMetadata = { type: RPCType.HTTP, span: spanHandle.span };
    requestContext = setRPCMetadata(requestContext, rpcMetadata);
  }
  attachRequestRecordToRpcMetadata(rpcMetadata, requestRecord);
  if (requestRecord.dropReason !== undefined) {
    requestBodyCapture.stopBuffering();
  }
  return { requestRecord, requestContext, spanHandle, rpcMetadata };
}

export interface RequestObservation {
  requestRecord: RequestRecord;
  spanHandle: SpanHandle;
  rpcMetadata?: RPCMetadata;
  method: string;
  startTimeMillis: number;
}

export interface FinalizeRequestObservationOptions {
  observation: RequestObservation;
  completedAtMillis: number;
  statusCode: number;
  route?: string;
  requestHeaders: Headers | Record<string, string | string[] | undefined>;
  responseHeaders: Headers | Record<string, string | number | string[] | undefined>;
  capturedRequestBody?: CapturedBody;
  capturedResponseBody?: CapturedBody;
}

export function finalizeRequestObservation(options: FinalizeRequestObservationOptions): void {
  const { observation, statusCode, route } = options;
  const { requestRecord, spanHandle, rpcMetadata, method } = observation;
  requestRecord.durationSeconds = (options.completedAtMillis - observation.startTimeMillis) / 1000;
  const { span, ownSpan } = spanHandle;
  writeRequestAttribute(span, requestRecord, "http.response.status_code", statusCode);
  const requestBodySize = options.capturedRequestBody?.size;
  if (requestBodySize !== undefined) {
    writeRequestAttribute(span, requestRecord, "http.request.body.size", requestBodySize);
  }
  const responseBodySize = options.capturedResponseBody?.size;
  if (responseBodySize !== undefined) {
    writeRequestAttribute(span, requestRecord, "http.response.body.size", responseBodySize);
  }
  if (route !== undefined) {
    writeRequestAttribute(span, requestRecord, "http.route", route);
    if (rpcMetadata) {
      rpcMetadata.route = route;
    }
    if (ownSpan?.isRecording()) {
      ownSpan.updateName(`${method} ${route}`);
    }
  } else {
    // An empty route clears one set by the producing instrumentation; request
    // metrics omit empty routes.
    requestRecord.attributes["http.route"] = "";
  }
  if (ownSpan && statusCode >= 500) {
    ownSpan.setStatus({ code: SpanStatusCode.ERROR });
  }
  // A dropped request's spans are never released, so a stash entry for it
  // would sit unconsumed until the cap evicts it.
  if (requestRecord.serverSpanId !== undefined && requestRecord.dropReason === undefined) {
    const config = getConfig();
    const stash: RequestStash = {};
    if (config.captureRequestHeaders) {
      stash.requestHeaders = normalizeHeaders(options.requestHeaders);
    }
    if (config.captureResponseHeaders) {
      stash.responseHeaders = normalizeHeaders(options.responseHeaders);
    }
    const requestBody = options.capturedRequestBody?.body;
    if (requestBody) {
      stash.requestBody = requestBody;
    }
    const responseBody = options.capturedResponseBody?.body;
    if (responseBody) {
      stash.responseBody = responseBody;
    }
    if (Object.keys(stash).length > 0) {
      getActiveSpanPipeline()?.updateStash(requestRecord.serverSpanId, stash);
    }
  }
  ownSpan?.end();
  getActiveSpanPipeline()?.handleTransportCompletion(requestRecord);
}

export interface FinalizeFailedRequestDispatchOptions {
  requestRecord: RequestRecord;
  spanHandle: SpanHandle;
  error: unknown;
  durationSeconds: number;
}

export function finalizeFailedRequestDispatch(options: FinalizeFailedRequestDispatchOptions): void {
  const { requestRecord, spanHandle, error, durationSeconds } = options;
  requestRecord.durationSeconds = durationSeconds;
  if (spanHandle.span?.isRecording()) {
    spanHandle.span.recordException(coerceToException(error));
  }
  if (spanHandle.ownSpan) {
    spanHandle.ownSpan.setStatus({ code: SpanStatusCode.ERROR });
    spanHandle.ownSpan.end();
  }
  getActiveSpanPipeline()?.handleTransportCompletion(requestRecord);
}

// Values remain raw so all redaction happens at the export boundary.
function normalizeHeaders(
  headers: Headers | Record<string, string | number | string[] | undefined>,
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  if (isWebHeaders(headers)) {
    // The Headers API combines repeated values except Set-Cookie.
    for (const [name, value] of headers) {
      const existing = normalized[name];
      if (existing === undefined) {
        normalized[name] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        normalized[name] = [existing, value];
      }
    }
    return normalized;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized[name.toLowerCase()] = Array.isArray(value) ? value : String(value);
    }
  }
  return normalized;
}

// Duck-typed on iterability: a plain header record has no Symbol.iterator, and
// the Headers instance may come from another realm's implementation.
function isWebHeaders(headers: object): headers is Headers {
  return typeof (headers as Headers)[Symbol.iterator] === "function";
}

function warnAboutNonRecordingServerSpan(): void {
  logWarning(
    "The OpenTelemetry sampler did not sample the SERVER span of a request. Only sampled requests are exported to Apitally as traces and request logs. Request metrics include all requests.",
  );
}

function warnAboutUnattachedSpanProcessor(): void {
  logWarning(
    "The recording OpenTelemetry SERVER span created for a request did not reach ApitallySpanProcessor. Traces and request logs are unavailable while request metrics continue. To resolve this, add the ApitallySpanProcessor instance to your tracer provider's spanProcessors constructor option or the NodeSDK spanProcessors option.",
  );
}
