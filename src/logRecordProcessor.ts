import { type Context, trace } from "@opentelemetry/api";
import type { InstrumentationScope } from "@opentelemetry/core";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import { logDebug, logWarning } from "./logger.js";
import type { SpanPipeline } from "./spanProcessor.js";

const MAX_BUFFERED_LOG_RECORDS = 1_000;

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
      if (!this.spanPipeline.isRequestInFlight(serverSpanId)) {
        this.downstream.onEmit(logRecord, context);
        return;
      }
      const buffer = this.buffered.get(serverSpanId);
      if (!buffer) {
        this.buffered.set(serverSpanId, [logRecord]);
      } else if (buffer.length < MAX_BUFFERED_LOG_RECORDS) {
        buffer.push(logRecord);
      } else {
        logDebug("Apitally log buffer cap reached, dropping the log record");
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
