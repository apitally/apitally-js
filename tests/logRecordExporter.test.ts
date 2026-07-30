import { trace } from "@opentelemetry/api";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { describe, expect, it } from "vitest";
import { ApitallyLogRecordExporter } from "../src/logRecordExporter.js";
import {
  createBatchProcessorOptions,
  createInMemorySpool,
  createLogRecordProcessor,
  createTracePipeline,
  readSerializedLogRecords,
  startServerSpan,
} from "./utils.js";

describe("logRecordExporter", () => {
  it("truncates string bodies and attribute values at 2,048 characters on export, leaving apitally-scoped records intact", async () => {
    const spool = createInMemorySpool();
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider } = createLogRecordProcessor(
      pipeline,
      new BatchLogRecordProcessor({
        exporter: new ApitallyLogRecordExporter(spool),
        ...createBatchProcessorOptions(),
      }),
    );
    const { span, request } = startServerSpan(tracer);
    loggerProvider.getLogger("myapp").emit({
      body: "a".repeat(3_000),
      attributes: { note: "b".repeat(3_000), count: 7 },
      context: trace.setSpan(request.context, span),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    loggerProvider.getLogger("apitally").emit({ body: "c".repeat(3_000) });

    await loggerProvider.forceFlush();
    const records = readSerializedLogRecords();
    expect(records.map((record) => record.instrumentationScope.name)).toEqual([
      "myapp",
      "apitally",
    ]);
    const [appRecord, apitallyRecord] = records;
    expect(appRecord.body).toBe("a".repeat(2_048));
    expect(appRecord.spanContext?.traceId).toBe(span.spanContext().traceId);
    expect(appRecord.attributes.note).toBe("b".repeat(2_048));
    expect(appRecord.attributes.count).toBe(7);
    expect(appRecord.attributes["apitally.request.server_span_id"]).toBe(span.spanContext().spanId);
    expect(apitallyRecord.body).toBe("c".repeat(3_000));
  });
});
