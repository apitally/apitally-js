import type { LogAttributes } from "@opentelemetry/api-logs";
import type { ExportResult } from "@opentelemetry/core";
import { ProtobufLogsSerializer } from "@opentelemetry/otlp-transformer";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { serializeInChunksToSpool } from "./exportSerialization.js";
import { truncateLogStringValue } from "./logRecordTruncation.js";
import type { Spool } from "./spool.js";

const APITALLY_SCOPE_NAME = "apitally";

// Released records are truncated on copies before serialization; `apitally`
// startup records remain unchanged.
export class ApitallyLogRecordExporter implements LogRecordExporter {
  private readonly spool: Spool;

  constructor(spool: Spool) {
    this.spool = spool;
  }

  export(logRecords: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
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

function truncateLogRecordStrings(logRecord: ReadableLogRecord): ReadableLogRecord {
  if (logRecord.instrumentationScope.name === APITALLY_SCOPE_NAME) {
    return logRecord;
  }
  const body = truncateLogStringValue(logRecord.body);
  const attributes: LogAttributes = {};
  let truncated = body !== logRecord.body;
  for (const [key, value] of Object.entries(logRecord.attributes)) {
    const truncatedValue = truncateLogStringValue(value);
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
