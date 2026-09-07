import { type Context, trace } from "@opentelemetry/api";
import type { InstrumentationScope } from "@opentelemetry/core";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
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
  private readonly buffered = new Map<string, SdkLogRecord[]>();

  constructor(downstream: LogRecordProcessor, spanPipeline: SpanPipeline) {
    this.downstream = downstream;
    this.spanPipeline = spanPipeline;
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

  onEmit(logRecord: SdkLogRecord, context?: Context): void {
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

function truncateLogRecordStrings(logRecord: SdkLogRecord): void {
  if (typeof logRecord.body === "string" && logRecord.body.length > MAX_LOG_STRING_LENGTH) {
    logRecord.setBody(logRecord.body.slice(0, MAX_LOG_STRING_LENGTH));
  }
  for (const [key, value] of Object.entries(logRecord.attributes)) {
    if (typeof value === "string" && value.length > MAX_LOG_STRING_LENGTH) {
      logRecord.setAttribute(key, value.slice(0, MAX_LOG_STRING_LENGTH));
    }
  }
}
