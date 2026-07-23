import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { describe, expect, it } from "vitest";
import { setConfig } from "../../src/config.js";
import {
  ApitallyLogRecordExporter,
  MAX_BUFFERED_LOG_RECORDS,
} from "../../src/logPipeline.js";
import { decodedAttributes } from "../stubOtlpServer.js";
import {
  createInMemorySpool,
  createLogPipeline,
  createTracePipeline,
  readLogsExportFromSpool,
  startServerSpan,
  WRITE_TOKEN,
} from "../utils.js";

describe("logPipeline", () => {
  it("exports a log emitted inside a request with the request linkage once the request is kept", () => {
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

  it("discards a request's buffered logs when the response-stage decision drops the request", () => {
    setConfig({ writeToken: WRITE_TOKEN, sampleOnResponse: () => false });
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { loggerProvider, logExporter } = createLogPipeline(pipeline);
    const { span, request } = startServerSpan(tracer);
    loggerProvider.getLogger("myapp").emit({
      body: "inside request",
      context: trace.setSpan(request.context, span),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
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

  it("caps buffered log records per request, keeping the earliest", () => {
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
    expect(bodies).toHaveLength(MAX_BUFFERED_LOG_RECORDS);
    expect(bodies[0]).toBe("log 0");
    expect(bodies).not.toContain(`log ${MAX_BUFFERED_LOG_RECORDS}`);
  });

  it("truncates string bodies and attribute values at 2,048 characters on export, leaving apitally-scoped records intact", async () => {
    const spool = createInMemorySpool();
    const { pipeline, tracer } = createTracePipeline();
    const { loggerProvider } = createLogPipeline(
      pipeline,
      new BatchLogRecordProcessor({
        exporter: new ApitallyLogRecordExporter(spool),
        scheduledDelayMillis: 3_600_000,
        exportTimeoutMillis: 30_000,
        maxQueueSize: 2_048,
        maxExportBatchSize: 512,
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

    const exported = await readLogsExportFromSpool(loggerProvider, spool);
    expect(exported.resourceLogs).toHaveLength(1);
    const scopeLogs = exported.resourceLogs[0].scopeLogs;
    expect(scopeLogs.map((scope) => scope.scope?.name)).toEqual([
      "myapp",
      "apitally",
    ]);
    const [appRecord] = scopeLogs[0].logRecords;
    expect(appRecord.body?.stringValue).toBe("a".repeat(2_048));
    expect(
      Buffer.from(appRecord.traceId ?? Uint8Array.of()).toString("hex"),
    ).toBe(span.spanContext().traceId);
    const attributes = decodedAttributes(appRecord.attributes);
    expect(attributes.note).toBe("b".repeat(2_048));
    expect(attributes.count).toBe(7);
    expect(attributes["apitally.request.server_span_id"]).toBe(
      span.spanContext().spanId,
    );
    const [startupRecord] = scopeLogs[1].logRecords;
    expect(startupRecord.body?.stringValue).toBe("c".repeat(3_000));
  });
});
