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
  it("serializes released records to the spool with their request association", async () => {
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
      body: "inside request",
      attributes: { count: 7 },
      context: trace.setSpan(request.context, span),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    loggerProvider.getLogger("apitally").emit({ body: "startup" });

    await loggerProvider.forceFlush();
    const records = readSerializedLogRecords();
    expect(records.map((record) => record.instrumentationScope.name)).toEqual([
      "myapp",
      "apitally",
    ]);
    const [appRecord, apitallyRecord] = records;
    expect(appRecord.body).toBe("inside request");
    expect(appRecord.spanContext?.traceId).toBe(span.spanContext().traceId);
    expect(appRecord.attributes.count).toBe(7);
    expect(appRecord.attributes["apitally.request.server_span_id"]).toBe(span.spanContext().spanId);
    expect(apitallyRecord.body).toBe("startup");
  });
});
