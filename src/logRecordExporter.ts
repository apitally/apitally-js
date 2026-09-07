import type { ExportResult } from "@opentelemetry/core";
import { ProtobufLogsSerializer } from "@opentelemetry/otlp-transformer";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { serializeInChunksToSpool } from "./exportSerialization.js";
import type { Spool } from "./spool.js";

export class ApitallyLogRecordExporter implements LogRecordExporter {
  private readonly spool: Spool;

  constructor(spool: Spool) {
    this.spool = spool;
  }

  export(logRecords: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    serializeInChunksToSpool(
      logRecords,
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
