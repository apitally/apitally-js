import {
  type Attributes,
  type Context,
  context,
  createContextKey,
  type Span,
} from "@opentelemetry/api";
import { getRPCMetadata, type RPCMetadata } from "@opentelemetry/core";

// Write sites resolve the request's SERVER span through this handle: under a child
// span, the active span is not the SERVER span, and OTel has no public upward walk.
export interface SpanHandle {
  span?: Span;
  // This set-once reference preserves lifecycle ownership if span later changes.
  ownSpan?: Span;
}

export interface ConsumerHolder {
  identifier?: string;
  name?: string;
  group?: string;
}

// Requests dropped for these reasons are still counted in request metrics,
// except preflight and websocket requests, which are never recorded.
export type RequestDropReason = "excluded" | "method" | "scheme" | "sampled-out";

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

const RPC_REQUEST_HOLDERS_KEY = Symbol.for("apitally.rpcRequestHolders");

interface RequestHolders {
  spanHandle: SpanHandle;
  requestRecord: RequestRecord;
  consumerHolder: ConsumerHolder;
}

type RPCMetadataWithRequestHolders = RPCMetadata & {
  [RPC_REQUEST_HOLDERS_KEY]?: RequestHolders;
};

// Mutable holders carry changing request state because OTel contexts are immutable.
export function withRequestHolders(
  baseContext: Context,
  spanHandle: SpanHandle,
  record: RequestRecord,
  consumerHolder: ConsumerHolder,
): Context {
  const holders = { spanHandle, requestRecord: record, consumerHolder };
  const rpcMetadata = getRPCMetadata(baseContext) as RPCMetadataWithRequestHolders | undefined;
  if (rpcMetadata) {
    rpcMetadata[RPC_REQUEST_HOLDERS_KEY] = holders;
  }
  return baseContext
    .setValue(SPAN_HANDLE_KEY, spanHandle)
    .setValue(REQUEST_RECORD_KEY, record)
    .setValue(CONSUMER_HOLDER_KEY, consumerHolder);
}

export function getServerSpan(activeContext: Context = context.active()): Span | undefined {
  const spanHandle = activeContext.getValue(SPAN_HANDLE_KEY) as SpanHandle | undefined;
  return spanHandle?.span ?? getRpcRequestHolders(activeContext)?.spanHandle.span;
}

export function getRequestRecord(
  activeContext: Context = context.active(),
): RequestRecord | undefined {
  return (
    (activeContext.getValue(REQUEST_RECORD_KEY) as RequestRecord | undefined) ??
    getRpcRequestHolders(activeContext)?.requestRecord
  );
}

export function getConsumerHolder(
  activeContext: Context = context.active(),
): ConsumerHolder | undefined {
  return (
    (activeContext.getValue(CONSUMER_HOLDER_KEY) as ConsumerHolder | undefined) ??
    getRpcRequestHolders(activeContext)?.consumerHolder
  );
}

function getRpcRequestHolders(activeContext: Context): RequestHolders | undefined {
  return (getRPCMetadata(activeContext) as RPCMetadataWithRequestHolders | undefined)?.[
    RPC_REQUEST_HOLDERS_KEY
  ];
}
