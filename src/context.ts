import {
  type Attributes,
  type Context,
  context,
  createContextKey,
  type Span,
} from "@opentelemetry/api";

// Write sites resolve the request's SERVER span through this handle: under a child
// span, the active span is not the SERVER span, and OTel has no public upward walk.
export interface SpanHandle {
  span?: Span;
}

export interface ConsumerHolder {
  identifier?: string;
  name?: string;
  group?: string;
}

// Requests dropped for these reasons are still counted in request metrics,
// except preflight and websocket requests, which are never recorded.
export type RequestDropReason = "excluded" | "options" | "websocket" | "sampled-out";

// Transport attributes are applied to exported spans last and used for metrics,
// so transport values take precedence.
export interface RequestRecord {
  attributes: Attributes;
  serverSpanId?: string;
  // Transport-measured request duration, set at completion; the duration
  // histogram records it independent of span timing.
  durationSeconds?: number;
  dropReason?: RequestDropReason;
}

export const SPAN_HANDLE_KEY = createContextKey("apitally-span-handle");
export const REQUEST_RECORD_KEY = createContextKey("apitally-request-record");
export const CONSUMER_HOLDER_KEY = createContextKey("apitally-consumer-holder");

// Mutable holders carry changing request state because OTel contexts are immutable.
export function withRequestHolders(
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

export function getServerSpan(activeContext: Context = context.active()): Span | undefined {
  return (activeContext.getValue(SPAN_HANDLE_KEY) as SpanHandle | undefined)?.span;
}

export function getRequestRecord(
  activeContext: Context = context.active(),
): RequestRecord | undefined {
  return activeContext.getValue(REQUEST_RECORD_KEY) as RequestRecord | undefined;
}

export function getConsumerHolder(
  activeContext: Context = context.active(),
): ConsumerHolder | undefined {
  return activeContext.getValue(CONSUMER_HOLDER_KEY) as ConsumerHolder | undefined;
}
