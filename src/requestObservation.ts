import {
  type Attributes,
  type Context,
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
import { normalizeHeaders } from "./capture.js";
import type { ApitallyConfig } from "./config.js";
import {
  type ConsumerHolder,
  type RequestRecord,
  type SpanHandle,
  withRequestHolders,
} from "./context.js";
import { logWarning } from "./logger.js";
import {
  getActiveSpanPipeline,
  type RequestStash,
  writeRequestAttribute,
} from "./spanProcessor.js";

export interface StartServerSpanOptions {
  activeContext: Context;
  extractedContext: Context;
  tracerName: string;
  method: string;
  startAttributes: Attributes;
  spanHandle: SpanHandle;
  record: RequestRecord;
  consumerHolder: ConsumerHolder;
}

export interface ServerSpanObservation {
  requestContext: Context;
  ownSpan?: Span;
  rpcMetadata?: RPCMetadata;
}

export function adoptOrStartServerSpan(
  options: StartServerSpanOptions,
): ServerSpanObservation {
  const {
    activeContext,
    extractedContext,
    tracerName,
    method,
    startAttributes,
    spanHandle,
    record,
    consumerHolder,
  } = options;
  const activeSpan = trace.getSpan(activeContext);
  let requestContext: Context;
  let ownSpan: Span | undefined;
  // Span kind is not part of the OTel API surface, so read the SDK-level
  // property from whichever package copy produced the span.
  if (
    activeSpan?.isRecording() &&
    (activeSpan as { kind?: unknown }).kind === SpanKind.SERVER
  ) {
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
    requestContext = withRequestHolders(
      extractedContext,
      spanHandle,
      record,
      consumerHolder,
    );
    ownSpan = trace
      .getTracer(tracerName)
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

  // Middleware-based span producers inspect OTel RPC metadata to demote duplicate
  // transport spans; completion adds the route.
  let rpcMetadata = getRPCMetadata(requestContext);
  if (!rpcMetadata && spanHandle.span) {
    rpcMetadata = { type: RPCType.HTTP, span: spanHandle.span };
    requestContext = setRPCMetadata(requestContext, rpcMetadata);
  }
  return { requestContext, ownSpan, rpcMetadata };
}

export interface FinalizeRequestOptions {
  record: RequestRecord;
  spanHandle: SpanHandle;
  ownSpan?: Span;
  rpcMetadata?: RPCMetadata;
  config: ApitallyConfig;
  method: string;
  durationSeconds: number;
  statusCode: number;
  route?: string;
  requestHeaders: Headers | Record<string, string | string[] | undefined>;
  responseHeaders:
    | Headers
    | Record<string, string | number | string[] | undefined>;
  requestBodySize?: number;
  responseBodySize?: number;
  requestBody?: Buffer;
  responseBody?: Buffer;
}

export function finalizeRecordAndReleaseRequest(
  options: FinalizeRequestOptions,
): void {
  const {
    record,
    spanHandle,
    ownSpan,
    rpcMetadata,
    config,
    method,
    statusCode,
    route,
  } = options;
  record.durationSeconds = options.durationSeconds;
  const span = spanHandle.span;
  writeRequestAttribute(span, record, "http.response.status_code", statusCode);
  if (options.requestBodySize !== undefined) {
    writeRequestAttribute(
      span,
      record,
      "http.request.body.size",
      options.requestBodySize,
    );
  }
  if (options.responseBodySize !== undefined) {
    writeRequestAttribute(
      span,
      record,
      "http.response.body.size",
      options.responseBodySize,
    );
  }
  if (route !== undefined) {
    writeRequestAttribute(span, record, "http.route", route);
    if (rpcMetadata) {
      rpcMetadata.route = route;
    }
    if (ownSpan?.isRecording()) {
      ownSpan.updateName(`${method} ${route}`);
    }
  } else {
    // An empty route clears one set by the producing instrumentation; request
    // metrics omit empty routes.
    record.attributes["http.route"] = "";
  }
  if (ownSpan && statusCode >= 500) {
    ownSpan.setStatus({ code: SpanStatusCode.ERROR });
  }
  // A dropped request's spans are never released, so a stash entry for it
  // would sit unconsumed until the cap evicts it.
  if (record.serverSpanId !== undefined && record.dropReason === undefined) {
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
      getActiveSpanPipeline()?.updateStash(record.serverSpanId, stash);
    }
  }
  ownSpan?.end();
  getActiveSpanPipeline()?.handleTransportCompletion(record);
}

function warnAboutNonRecordingServerSpan(): void {
  logWarning(
    "The OpenTelemetry sampler did not sample the SERVER span of a request. Only sampled requests are exported to Apitally as traces and request logs. Request metrics include all requests.",
  );
}
