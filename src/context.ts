import {
  type Attributes,
  type Context,
  context,
  createContextKey,
  type Span,
} from "@opentelemetry/api";
import { getRPCMetadata, type RPCMetadata, RPCType } from "@opentelemetry/core";
import type { ValidationErrorDetail } from "./validationErrors.js";

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
  // Error state for the validation and server error events; it exists
  // independently of the SERVER span and of the drop decision.
  exception?: unknown;
  validationErrors?: ValidationErrorDetail[];
}

export const SPAN_HANDLE_KEY = createContextKey("apitally-span-handle");
export const REQUEST_RECORD_KEY = createContextKey("apitally-request-record");
export const CONSUMER_HOLDER_KEY = createContextKey("apitally-consumer-holder");

const RPC_REQUEST_RECORD_KEY = Symbol.for("apitally.rpcRequestRecord");

type RPCMetadataWithRequestRecord = RPCMetadata & {
  [RPC_REQUEST_RECORD_KEY]?: RequestRecord;
};

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

export function attachRequestRecordToRpcMetadata(
  rpcMetadata: RPCMetadata | undefined,
  record: RequestRecord,
): void {
  if (rpcMetadata) {
    (rpcMetadata as RPCMetadataWithRequestRecord)[RPC_REQUEST_RECORD_KEY] = record;
  }
}

export function getServerSpan(activeContext: Context = context.active()): Span | undefined {
  const spanHandle = activeContext.getValue(SPAN_HANDLE_KEY) as SpanHandle | undefined;
  const rpcMetadata = getRPCMetadata(activeContext) as RPCMetadataWithRequestRecord | undefined;
  return (
    spanHandle?.span ??
    (rpcMetadata?.type === RPCType.HTTP && rpcMetadata[RPC_REQUEST_RECORD_KEY]
      ? rpcMetadata.span
      : undefined)
  );
}

export function getRequestRecord(
  activeContext: Context = context.active(),
): RequestRecord | undefined {
  const rpcMetadata = getRPCMetadata(activeContext) as RPCMetadataWithRequestRecord | undefined;
  return (
    (activeContext.getValue(REQUEST_RECORD_KEY) as RequestRecord | undefined) ??
    rpcMetadata?.[RPC_REQUEST_RECORD_KEY]
  );
}

export function getConsumerHolder(
  activeContext: Context = context.active(),
): ConsumerHolder | undefined {
  return activeContext.getValue(CONSUMER_HOLDER_KEY) as ConsumerHolder | undefined;
}
