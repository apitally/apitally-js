import { type Context, trace } from "@opentelemetry/api";
import type { InstrumentationScope } from "@opentelemetry/core";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { LogRecordMaskingCallback } from "./config.js";
import { logDebug, logWarning } from "./logger.js";
import type { SpanPipeline } from "./spanProcessor.js";

const MAX_BUFFERED_LOG_RECORDS = 1_000;
const MAX_LOG_STRING_LENGTH = 2_048;

const SERVER_SPAN_ID_ATTRIBUTE = "apitally.request.server_span_id";
const APITALLY_SCOPE_NAME = "apitally";

// Records resolve request association through the span pipeline's in-flight
// map. Records without an associated request are dropped except the `apitally`
// startup event.
export class ApitallyLogRecordProcessor implements LogRecordProcessor {
  private readonly downstream: LogRecordProcessor;
  private readonly spanPipeline: SpanPipeline;
  private readonly maskLogRecord?: LogRecordMaskingCallback;
  private readonly buffered = new Map<string, ReadWriteLogRecord[]>();

  constructor(
    downstream: LogRecordProcessor,
    spanPipeline: SpanPipeline,
    maskLogRecord?: LogRecordMaskingCallback,
  ) {
    this.downstream = downstream;
    this.spanPipeline = spanPipeline;
    this.maskLogRecord = maskLogRecord;
    spanPipeline.onRequestFinished = (serverSpanId, kept) => {
      this.releaseRequestLogRecords(serverSpanId, kept);
    };
  }

  enabled({
    context,
    instrumentationScope,
  }: {
    context: Context;
    instrumentationScope: InstrumentationScope;
  }): boolean {
    if (instrumentationScope.name === APITALLY_SCOPE_NAME) {
      return true;
    }
    const spanId = trace.getSpanContext(context)?.spanId;
    return spanId !== undefined && this.spanPipeline.resolveServerSpanId(spanId) !== undefined;
  }

  onEmit(logRecord: ReadWriteLogRecord, context?: Context): void {
    try {
      const emittingSpanId = logRecord.spanContext?.spanId;
      const serverSpanId =
        emittingSpanId === undefined
          ? undefined
          : this.spanPipeline.resolveServerSpanId(emittingSpanId);
      if (serverSpanId === undefined) {
        if (logRecord.instrumentationScope.name === APITALLY_SCOPE_NAME) {
          this.downstream.onEmit(logRecord, context);
        }
        return;
      }
      if (this.maskLogRecord && logRecord.instrumentationScope.name !== APITALLY_SCOPE_NAME) {
        let masked: unknown;
        try {
          masked = this.maskLogRecord(logRecord);
        } catch {
          logWarning(
            "The Apitally maskLogRecord callback threw an error, so the log record was dropped",
          );
          return;
        }
        if (masked === null || masked === undefined) {
          return;
        }
        if (masked !== logRecord) {
          logWarning(
            "The Apitally maskLogRecord callback returned an invalid value, so the log record was dropped. Mask callbacks must synchronously return the input log record, null, or undefined.",
          );
          return;
        }
      }
      logRecord.setAttribute(SERVER_SPAN_ID_ATTRIBUTE, serverSpanId);
      truncateLogRecordStrings(logRecord);
      if (!this.spanPipeline.isRequestInFlight(serverSpanId)) {
        this.downstream.onEmit(logRecord, context);
        return;
      }
      const buffer = this.buffered.get(serverSpanId);
      if (buffer && buffer.length >= MAX_BUFFERED_LOG_RECORDS) {
        logDebug("Apitally log buffer cap reached, dropping the log record");
        return;
      }
      if (buffer) {
        buffer.push(logRecord);
      } else {
        this.buffered.set(serverSpanId, [logRecord]);
      }
    } catch (error) {
      logWarning(`Error in the Apitally log record processor: ${String(error)}`);
    }
  }

  forceFlush(): Promise<void> {
    return this.downstream.forceFlush();
  }

  // Requests still in flight can never release after shutdown, so their
  // buffered records are discarded with them.
  shutdown(): Promise<void> {
    this.buffered.clear();
    return this.downstream.shutdown();
  }

  private releaseRequestLogRecords(serverSpanId: string, kept: boolean): void {
    const buffer = this.buffered.get(serverSpanId);
    this.buffered.delete(serverSpanId);
    if (!kept || !buffer) {
      return;
    }
    for (const logRecord of buffer) {
      this.downstream.onEmit(logRecord);
    }
  }
}

function truncateLogRecordStrings(logRecord: ReadWriteLogRecord): void {
  if (typeof logRecord.body === "string" && logRecord.body.length > MAX_LOG_STRING_LENGTH) {
    logRecord.setBody(logRecord.body.slice(0, MAX_LOG_STRING_LENGTH));
  }
  for (const [key, value] of Object.entries(logRecord.attributes)) {
    if (typeof value === "string" && value.length > MAX_LOG_STRING_LENGTH) {
      logRecord.setAttribute(key, value.slice(0, MAX_LOG_STRING_LENGTH));
    }
  }
}
