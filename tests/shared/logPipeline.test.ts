import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { describe, expect, it } from "vitest";
import { setConfig } from "../../src/config.js";
import {
  ApitallyLogRecordExporter,
  MAX_BUFFERED_LOG_RECORDS,
} from "../../src/logPipeline.js";
import {
  createBatchProcessorOptions,
  createInMemorySpool,
  createLogPipeline,
  createTracePipeline,
  readSerializedLogRecords,
  startServerSpan,
  WRITE_TOKEN,
} from "../utils.js";

describe("logPipeline", () => {
  it("exports a log emitted inside a request with the request association once the request is kept", () => {
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider, logExporter } = createLogPipeline(pipeline);
    const { span, request } = startServerSpan(tracer);
    const child = tracer.startSpan(
      "child",
      {},
      trace.setSpan(request.context, span),
    );
    loggerProvider.getLogger("myapp").emit({
      body: "inside child",
      context: trace.setSpan(request.context, child),
    });
    child.end();
    span.end();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);

    pipeline.handleTransportCompletion(request.record);
    const [record] = logExporter.getFinishedLogRecords();
    expect(record.body).toBe("inside child");
    expect(record.spanContext?.traceId).toBe(span.spanContext().traceId);
    expect(record.spanContext?.spanId).toBe(child.spanContext().spanId);
    expect(record.attributes).toEqual({
      "apitally.request.server_span_id": span.spanContext().spanId,
    });
    expect(record.instrumentationScope.name).toBe("myapp");
  });

  it("exports a log emitted after the emitting child span ended while the request is in flight with the request association", () => {
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider, logExporter } = createLogPipeline(pipeline);
    const { span, request } = startServerSpan(tracer);
    const child = tracer.startSpan(
      "child",
      {},
      trace.setSpan(request.context, span),
    );
    child.end();
    loggerProvider.getLogger("myapp").emit({
      body: "after child end",
      context: trace.setSpan(request.context, child),
    });
    span.end();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);

    pipeline.handleTransportCompletion(request.record);
    const [record] = logExporter.getFinishedLogRecords();
    expect(record.body).toBe("after child end");
    expect(record.spanContext?.spanId).toBe(child.spanContext().spanId);
    expect(record.attributes).toEqual({
      "apitally.request.server_span_id": span.spanContext().spanId,
    });
  });

  it("passes a log emitted after a kept release through immediately", () => {
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider, logExporter } = createLogPipeline(pipeline);
    const { span, request } = startServerSpan(tracer);
    const late = tracer.startSpan(
      "late",
      {},
      trace.setSpan(request.context, span),
    );
    span.end();
    pipeline.handleTransportCompletion(request.record);
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);

    loggerProvider.getLogger("myapp").emit({
      body: "late log",
      context: trace.setSpan(request.context, late),
    });
    const [record] = logExporter.getFinishedLogRecords();
    expect(record.body).toBe("late log");
    expect(record.attributes).toEqual({
      "apitally.request.server_span_id": span.spanContext().spanId,
    });
    late.end();
  });

  it("passes a log emitted under the SERVER span itself after a kept release through immediately", () => {
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider, logExporter } = createLogPipeline(pipeline);
    const { span, request } = startServerSpan(tracer);
    span.end();
    pipeline.handleTransportCompletion(request.record);
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);

    loggerProvider.getLogger("myapp").emit({
      body: "late log",
      context: trace.setSpan(request.context, span),
    });
    const [record] = logExporter.getFinishedLogRecords();
    expect(record.body).toBe("late log");
    expect(record.attributes).toEqual({
      "apitally.request.server_span_id": span.spanContext().spanId,
    });
  });

  it("discards a request's buffered logs when the response-stage decision drops the request", () => {
    setConfig({ writeToken: WRITE_TOKEN, sampleOnResponse: () => false });
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider, logExporter } = createLogPipeline(pipeline);
    const { span, request } = startServerSpan(tracer);
    loggerProvider.getLogger("myapp").emit({
      body: "inside request",
      context: trace.setSpan(request.context, span),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it("drops log records emitted outside any request", () => {
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider, logExporter } = createLogPipeline(pipeline);
    const appLogger = loggerProvider.getLogger("myapp");
    appLogger.emit({ body: "no active span" });
    const backgroundRoot = tracer.startSpan("background job");
    appLogger.emit({
      body: "inside a background job",
      context: trace.setSpan(ROOT_CONTEXT, backgroundRoot),
    });
    backgroundRoot.end();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it("exports apitally-scoped records emitted without request context", () => {
    const { pipeline } = createTracePipeline();
    const { loggerProvider, logExporter } = createLogPipeline(pipeline);
    loggerProvider.getLogger("apitally").emit({ body: "startup" });
    const [record] = logExporter.getFinishedLogRecords();
    expect(record.body).toBe("startup");
    expect(record.attributes).toEqual({});
  });

  it("caps buffered log records per request, keeping the earliest and dropping new arrivals", () => {
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider, logExporter } = createLogPipeline(pipeline);
    const { span, request } = startServerSpan(tracer);
    const requestContext = trace.setSpan(request.context, span);
    const appLogger = loggerProvider.getLogger("myapp");
    for (let index = 0; index <= MAX_BUFFERED_LOG_RECORDS; index++) {
      appLogger.emit({ body: `log ${index}`, context: requestContext });
    }
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const bodies = logExporter
      .getFinishedLogRecords()
      .map((record) => record.body);
    expect(bodies).toEqual(
      Array.from(
        { length: MAX_BUFFERED_LOG_RECORDS },
        (_, index) => `log ${index}`,
      ),
    );
  });

  it("truncates string bodies and attribute values at 2,048 characters on export, leaving apitally-scoped records intact", async () => {
    const spool = createInMemorySpool();
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider } = createLogPipeline(
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
    expect(appRecord.attributes["apitally.request.server_span_id"]).toBe(
      span.spanContext().spanId,
    );
    expect(apitallyRecord.body).toBe("c".repeat(3_000));
  });
});
