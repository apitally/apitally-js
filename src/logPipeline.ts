import type { Context } from "@opentelemetry/api";
import type { AnyValue, LogAttributes } from "@opentelemetry/api-logs";
import type { ExportResult } from "@opentelemetry/core";
import { ProtobufLogsSerializer } from "@opentelemetry/otlp-transformer";
import type {
  LogRecordExporter,
  LogRecordProcessor,
  ReadableLogRecord,
  SdkLogRecord,
} from "@opentelemetry/sdk-logs";
import { serializeInChunksToSpool } from "./exporter.js";
import { logDebug, logWarning } from "./logger.js";
import type { SpanPipeline } from "./spanProcessor.js";
import type { Spool } from "./spool.js";

export const MAX_BUFFERED_LOG_RECORDS = 1_000;

const SERVER_SPAN_ID_ATTRIBUTE = "apitally.request.server_span_id";
const APITALLY_SCOPE_NAME = "apitally";
const MAX_STRING_LENGTH = 2_048;

// Records resolve request linkage through the span pipeline's in-flight map.
// Unlinked records are dropped except the `apitally` startup event.
export class LogPipeline implements LogRecordProcessor {
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
      logWarning(
        `Error in the Apitally log record processor: ${String(error)}`,
      );
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

// Released records are truncated on copies before serialization; `apitally`
// startup records remain unchanged.
export class ApitallyLogRecordExporter implements LogRecordExporter {
  private readonly spool: Spool;

  constructor(spool: Spool) {
    this.spool = spool;
  }

  export(
    logRecords: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    serializeInChunksToSpool(
      logRecords.map(truncateLogRecordStrings),
      (chunk) => ProtobufLogsSerializer.serializeRequest(chunk),
      this.spool,
      "logs",
      resultCallback,
    );
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function truncateLogRecordStrings(
  logRecord: ReadableLogRecord,
): ReadableLogRecord {
  if (logRecord.instrumentationScope.name === APITALLY_SCOPE_NAME) {
    return logRecord;
  }
  const body = truncateStringValue(logRecord.body);
  const attributes: LogAttributes = {};
  let truncated = body !== logRecord.body;
  for (const [key, value] of Object.entries(logRecord.attributes)) {
    const truncatedValue = truncateStringValue(value);
    attributes[key] = truncatedValue;
    truncated ||= truncatedValue !== value;
  }
  if (!truncated) {
    return logRecord;
  }
  return {
    hrTime: logRecord.hrTime,
    hrTimeObserved: logRecord.hrTimeObserved,
    spanContext: logRecord.spanContext,
    severityText: logRecord.severityText,
    severityNumber: logRecord.severityNumber,
    body,
    eventName: logRecord.eventName,
    // The serializer groups records by resource and scope identity.
    resource: logRecord.resource,
    instrumentationScope: logRecord.instrumentationScope,
    attributes,
    droppedAttributesCount: logRecord.droppedAttributesCount,
  };
}

function truncateStringValue(value: AnyValue): AnyValue {
  return typeof value === "string" && value.length > MAX_STRING_LENGTH
    ? value.slice(0, MAX_STRING_LENGTH)
    : value;
}
