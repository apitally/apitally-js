import {
  type Attributes,
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { getRPCMetadata, type RPCMetadata, RPCType, setRPCMetadata } from "@opentelemetry/core";
import { type BodyCapture, normalizeHeaders } from "./capture.js";
import { getConfig } from "./config.js";
import {
  getConsumerHolder,
  type RequestRecord,
  type SpanHandle,
  withRequestHolders,
} from "./context.js";
import { logWarning } from "./logger.js";
import {
  getActiveSpanPipeline,
  isApitallySpanProcessorDeclared,
  type RequestStash,
  writeRequestAttribute,
} from "./spanProcessor.js";

interface StartRequestObservationOptions {
  activeContext: Context;
  extractedContext: Context;
  tracerName: string;
  method: string;
  startAttributes: Attributes;
  requestBodyCapture: BodyCapture;
}

export function startRequestObservation(options: StartRequestObservationOptions) {
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
  let ownSpan: Span | undefined;
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
    ownSpan = trace
      .getTracer(tracerName)
      .startSpan(method, { kind: SpanKind.SERVER, attributes: startAttributes }, requestContext);
    if (!ownSpan.isRecording()) {
      warnAboutNonRecordingServerSpan();
      requestRecord.dropReason = "sampled-out";
      ownSpan = undefined;
    } else {
      spanHandle.span = ownSpan;
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
  if (requestRecord.dropReason !== undefined) {
    requestBodyCapture.stopBuffering();
  }
  return { requestRecord, requestContext, spanHandle, ownSpan, rpcMetadata };
}

export interface FinalizeRequestOptions {
  requestRecord: RequestRecord;
  spanHandle: SpanHandle;
  ownSpan?: Span;
  rpcMetadata?: RPCMetadata;
  method: string;
  durationSeconds: number;
  statusCode: number;
  route?: string;
  requestHeaders: Headers | Record<string, string | string[] | undefined>;
  responseHeaders: Headers | Record<string, string | number | string[] | undefined>;
  requestBodySize?: number;
  responseBodySize?: number;
  requestBody?: Buffer;
  responseBody?: Buffer;
}

export function finalizeRecordAndReleaseRequest(options: FinalizeRequestOptions): void {
  const { requestRecord, spanHandle, ownSpan, rpcMetadata, method, statusCode, route } = options;
  requestRecord.durationSeconds = options.durationSeconds;
  const span = spanHandle.span;
  writeRequestAttribute(span, requestRecord, "http.response.status_code", statusCode);
  if (options.requestBodySize !== undefined) {
    writeRequestAttribute(span, requestRecord, "http.request.body.size", options.requestBodySize);
  }
  if (options.responseBodySize !== undefined) {
    writeRequestAttribute(span, requestRecord, "http.response.body.size", options.responseBodySize);
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
    if (options.requestBody) {
      stash.requestBody = options.requestBody;
    }
    if (options.responseBody) {
      stash.responseBody = options.responseBody;
    }
    if (Object.keys(stash).length > 0) {
      getActiveSpanPipeline()?.updateStash(requestRecord.serverSpanId, stash);
    }
  }
  ownSpan?.end();
  getActiveSpanPipeline()?.handleTransportCompletion(requestRecord);
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
