import { context, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";
import { type SamplingCallback, setConfig } from "../src/config.js";
import type { RequestRecord } from "../src/context.js";
import {
  ApitallySpanProcessor,
  captureException,
  SpanPipeline,
  setActiveSpanPipeline,
  setConsumer,
  setRequestAttribute,
} from "../src/spanProcessor.js";
import {
  CollectingSpanProcessor,
  captureStderr,
  createBatchProcessorOptions,
  createTracePipeline,
  enableAsyncContextManager,
  startServerSpan,
  WRITE_TOKEN,
} from "./utils.js";

// The low 64 bits of the trace ID decide sampling; rate 0.5 keeps IDs below 2^63.
const TRACE_ID_KEPT_AT_HALF = `${"0".repeat(16)}7fffffffffffffff`;
const TRACE_ID_DROPPED_AT_HALF = `${"0".repeat(16)}8000000000000000`;
// The highest trace ID fails every sampling rate below 1.
const TRACE_ID_DROPPED_BELOW_ONE = "f".repeat(32);

describe("spanProcessor", () => {
  it("exports nothing until transport completion when the server span ends first, then releases the request exactly once", () => {
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    tracer.startSpan("child", {}, trace.setSpan(request.context, span)).end();
    span.end();
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    pipeline.handleTransportCompletion(request.record);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["child", "GET /items"]);
    pipeline.handleTransportCompletion(request.record);
    expect(exporter.getFinishedSpans()).toHaveLength(2);
  });

  it("exports nothing until the server span ends when the transport completes first", () => {
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    tracer.startSpan("child", {}, trace.setSpan(request.context, span)).end();
    pipeline.handleTransportCompletion(request.record);
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    span.end();
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["child", "GET /items"]);
  });

  it("drops non-SERVER local roots with their children and spans with an unknown local parent", () => {
    const { tracer, exporter } = createTracePipeline();
    const root = tracer.startSpan("background job");
    tracer.startSpan("child", {}, trace.setSpan(ROOT_CONTEXT, root)).end();
    root.end();
    const unknownLocalParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "00f067aa0ba902b7",
      isRemote: false,
      traceFlags: TraceFlags.SAMPLED,
    });
    tracer.startSpan("orphan", {}, unknownLocalParent).end();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it.each([
    { attributes: { "http.request.method": "OPTIONS", "url.path": "/items" } },
    { attributes: { "url.scheme": "ws", "url.path": "/ws" } },
    { attributes: { "http.scheme": "wss", "http.target": "/ws" } },
    { attributes: { "http.request.method": "GET", "url.path": "/healthz" } },
    {
      attributes: {
        "http.request.method": "GET",
        "url.path": "/",
        "user_agent.original": "kube-probe/1.30",
      },
    },
    { attributes: { "http.method": "OPTIONS", "http.target": "/items" } },
    { attributes: { "http.method": "GET", "http.target": "/healthz?full=1" } },
    {
      attributes: {
        "http.method": "GET",
        "http.target": "/",
        "http.user_agent": "kube-probe/1.30",
      },
    },
    {
      attributes: {
        "http.method": "GET",
        "http.url": "http://127.0.0.1:8000/healthz",
      },
    },
  ])(
    "drops preflight, websocket, and excluded requests at span start in both semconv normalizations (%#)",
    ({ attributes }) => {
      const { pipeline, tracer, exporter } = createTracePipeline();
      const { span, request } = startServerSpan(tracer, { attributes });
      span.end();
      pipeline.handleTransportCompletion(request.record);
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    },
  );

  it("adds user-configured exclude path patterns to the defaults", () => {
    setConfig({ writeToken: WRITE_TOKEN, excludePaths: ["^/internal/"] });
    const { pipeline, tracer, exporter } = createTracePipeline();
    for (const path of ["/internal/jobs", "/healthz", "/items"]) {
      const { span, request } = startServerSpan(tracer, {
        name: `GET ${path}`,
        attributes: { "url.path": path },
      });
      span.end();
      pipeline.handleTransportCompletion(request.record);
    }
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["GET /items"]);
  });

  it("derives path and query from the full URL attribute at span start when the instrumentation omits them", () => {
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer, {
      attributes: {
        "http.method": "GET",
        "http.url": "http://127.0.0.1:8000/items?category=books",
      },
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["url.path"]).toBe("/items");
    expect(exported.attributes["url.query"]).toBe("category=books");
    expect(exported.attributes["http.target"]).toBe("/items?category=books");
  });

  it("samples deterministically by trace id with both stages testing the same value", () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      sampleRate: 0.5,
      sampleOnResponse: () => 0.5,
    });
    const { pipeline, tracer, exporter } = createTracePipeline();
    for (const traceId of [TRACE_ID_KEPT_AT_HALF, TRACE_ID_DROPPED_AT_HALF]) {
      const { span, request } = startServerSpan(tracer, { traceId });
      span.end();
      pipeline.handleTransportCompletion(request.record);
    }
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].spanContext().traceId).toBe(TRACE_ID_KEPT_AT_HALF);
  });

  it.each([
    { sampleRate: 1, callbackResult: false, expectedCount: 0 },
    { sampleRate: 0, callbackResult: true, expectedCount: 1 },
    { sampleRate: 0, callbackResult: undefined, expectedCount: 0 },
    { sampleRate: 1, callbackResult: undefined, expectedCount: 1 },
  ])(
    "resolves the request-stage rate from the callback with abstention falling back to the static rate (%#)",
    ({ sampleRate, callbackResult, expectedCount }) => {
      setConfig({
        writeToken: WRITE_TOKEN,
        sampleRate,
        sampleOnRequest: () => callbackResult,
      });
      const { pipeline, tracer, exporter } = createTracePipeline();
      const { span, request } = startServerSpan(tracer, {
        traceId: TRACE_ID_DROPPED_BELOW_ONE,
      });
      span.end();
      pipeline.handleTransportCompletion(request.record);
      expect(exporter.getFinishedSpans()).toHaveLength(expectedCount);
    },
  );

  it("keeps error responses and drops healthy ones through the response-stage sampling callback", () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      sampleOnResponse: (span) => span.attributes["http.response.status_code"] === 500 || 0.05,
    });
    const { pipeline, tracer, exporter } = createTracePipeline();
    for (const statusCode of [200, 500]) {
      const { span, request } = startServerSpan(tracer, {
        name: `GET /${statusCode}`,
        traceId: TRACE_ID_DROPPED_BELOW_ONE,
      });
      tracer.startSpan("child", {}, trace.setSpan(request.context, span)).end();
      span.end();
      request.record.attributes["http.response.status_code"] = statusCode;
      pipeline.handleTransportCompletion(request.record);
    }
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["child", "GET /500"]);
  });

  it("leaves the request-stage decision standing when the response-stage callback abstains", () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      sampleRate: 0,
      sampleOnRequest: () => true,
      sampleOnResponse: () => undefined,
    });
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer, {
      traceId: TRACE_ID_DROPPED_BELOW_ONE,
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it.each([
    {
      failure: "throws an error",
      callback: () => {
        throw new Error("boom");
      },
    },
    {
      failure: "returns an invalid value",
      callback: (() => "yes") as unknown as SamplingCallback,
    },
    {
      failure: "returns a Promise",
      callback: (() => Promise.resolve(0.5)) as unknown as SamplingCallback,
    },
  ])("keeps the request and warns when the sampling callback $failure", ({ callback }) => {
    const lines = captureStderr();
    setConfig({
      writeToken: WRITE_TOKEN,
      sampleRate: 0,
      sampleOnRequest: callback,
    });
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer, {
      traceId: TRACE_ID_DROPPED_BELOW_ONE,
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("sampleOnRequest");
  });

  it("never invokes a sampling callback for an excluded request", () => {
    const calls: unknown[] = [];
    setConfig({
      writeToken: WRITE_TOKEN,
      sampleOnRequest: (span) => {
        calls.push(span);
        return undefined;
      },
    });
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer, {
      attributes: { "url.path": "/healthz" },
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    expect(calls).toHaveLength(0);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("caps buffered spans per request, keeping the earliest and dropping new arrivals", () => {
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    const requestContext = trace.setSpan(request.context, span);
    for (let index = 0; index < 1_000; index++) {
      tracer.startSpan(`child-${index}`, {}, requestContext).end();
    }
    const overflowSpan = tracer.startSpan("overflow", {}, requestContext);
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const expectedNames = [
      ...Array.from({ length: 1_000 }, (_, index) => `child-${index}`),
      "GET /items",
    ];
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(expectedNames);
    overflowSpan.end();
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(expectedNames);
  });

  it("exports a late-ending descendant immediately after a kept release and discards it after a drop", () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      sampleOnResponse: (span) => span.attributes["http.response.status_code"] === 500,
    });
    const { pipeline, tracer, exporter } = createTracePipeline();
    for (const { statusCode, expectedNames } of [
      { statusCode: 500, expectedNames: ["GET /items", "late"] },
      { statusCode: 200, expectedNames: [] as string[] },
    ]) {
      const { span, request } = startServerSpan(tracer);
      const late = tracer.startSpan("late", {}, trace.setSpan(request.context, span));
      span.end();
      request.record.attributes["http.response.status_code"] = statusCode;
      pipeline.handleTransportCompletion(request.record);
      late.end();
      expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(expectedNames);
      exporter.reset();
    }
  });

  it("drops contrib per-message send and receive spans while keeping user socket spans", () => {
    const { pipeline, provider, tracer, exporter } = createTracePipeline();
    const contribTracer = provider.getTracer("@opentelemetry/instrumentation-express");
    const userTracer = provider.getTracer("myapp");
    const { span, request } = startServerSpan(tracer);
    const requestContext = trace.setSpan(request.context, span);
    contribTracer.startSpan("GET /items http receive", {}, requestContext).end();
    contribTracer.startSpan("GET /items http send", {}, requestContext).end();
    userTracer.startSpan("my websocket send", {}, requestContext).end();
    span.end();
    pipeline.handleTransportCompletion(request.record);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "my websocket send",
      "GET /items",
    ]);
  });

  it("writes a consumer set in the holder before span start onto the server span", () => {
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer, {
      consumerHolder: { identifier: "tenant-1", name: "Tenant One" },
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["apitally.consumer.identifier"]).toBe("tenant-1");
    expect(exported.attributes["apitally.consumer.name"]).toBe("Tenant One");
    expect(request.record.attributes["apitally.consumer.identifier"]).toBe("tenant-1");
  });

  it("writes setConsumer and setRequestAttribute through to the server span and records captureException events", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      setConsumer({ identifier: " tenant-1 ", group: "enterprise" });
      setRequestAttribute("custom.key", "value");
      captureException(new Error("request failed"));
      captureException(42);
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["apitally.consumer.identifier"]).toBe("tenant-1");
    expect(exported.attributes["apitally.consumer.group"]).toBe("enterprise");
    expect(exported.attributes["custom.key"]).toBe("value");
    expect(request.record.attributes["custom.key"]).toBe("value");
    expect(exported.events).toHaveLength(2);
    expect(exported.events[0].name).toBe("exception");
    expect(exported.events[0].attributes?.["exception.type"]).toBe("Error");
    expect(exported.events[0].attributes?.["exception.message"]).toBe("request failed");
    expect(exported.events[1].attributes?.["exception.message"]).toBe("42");
  });

  it("records a custom Error subclass by its constructor name", () => {
    class OrderFailedError extends Error {}

    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      captureException(new OrderFailedError("request failed"));
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.events[0].attributes?.["exception.type"]).toBe("OrderFailedError");
  });

  it("treats setConsumer, setRequestAttribute, and captureException as safe no-ops outside a request", () => {
    const { exporter } = createTracePipeline();
    expect(() => {
      setConsumer("tenant-1");
      setRequestAttribute("custom.key", "value");
      captureException(new Error("boom"));
    }).not.toThrow();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("invokes the metrics recorder at transport completion with the reason a request was not exported", () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      sampleOnRequest: (span) => (span.attributes["url.path"] === "/sampled" ? 0 : undefined),
    });
    const { pipeline, tracer, exporter } = createTracePipeline();
    const records: RequestRecord[] = [];
    pipeline.metricsRecorder = (record) => records.push(record);
    for (const attributes of [
      { "http.request.method": "GET", "url.path": "/healthz" },
      { "http.request.method": "OPTIONS", "url.path": "/items" },
      { "url.scheme": "wss", "url.path": "/ws" },
      { "http.request.method": "GET", "url.path": "/sampled" },
      { "http.request.method": "GET", "url.path": "/items" },
    ]) {
      const { span, request } = startServerSpan(tracer, { attributes });
      span.end();
      pipeline.handleTransportCompletion(request.record);
    }
    expect(records.map((record) => record.dropReason)).toEqual([
      "excluded",
      "method",
      "scheme",
      "sampled-out",
      undefined,
    ]);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["GET /items"]);
  });

  it("classifies and records metrics on transport completion without an in-flight request", () => {
    const { pipeline, exporter } = createTracePipeline();
    const records: RequestRecord[] = [];
    pipeline.metricsRecorder = (record) => records.push(record);
    const record: RequestRecord = {
      attributes: { "http.request.method": "OPTIONS" },
      serverSpanId: "00f067aa0ba902b7",
    };
    pipeline.handleTransportCompletion(record);
    expect(record.dropReason).toBe("method");
    expect(records).toEqual([record]);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("tolerates spans and flushes before the SDK is configured", async () => {
    const shell = new ApitallySpanProcessor();
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [shell],
    });
    const tracer = provider.getTracer("test");
    const first = startServerSpan(tracer);
    await shell.forceFlush();
    await shell.shutdown();

    const pipeline = new SpanPipeline(new SimpleSpanProcessor(exporter));
    setActiveSpanPipeline(pipeline);
    first.span.end();
    pipeline.handleTransportCompletion(first.request.record);
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    const second = startServerSpan(tracer, { name: "GET /second" });
    second.span.end();
    pipeline.handleTransportCompletion(second.request.record);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["GET /second"]);
  });

  it("receives spans through a user-owned provider while the user's exporters keep receiving all spans", () => {
    const userExporter = new InMemorySpanExporter();
    const apitallyExporter = new InMemorySpanExporter();
    const pipeline = new SpanPipeline(new SimpleSpanProcessor(apitallyExporter));
    setActiveSpanPipeline(pipeline);
    const provider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [new SimpleSpanProcessor(userExporter), new ApitallySpanProcessor()],
    });
    const tracer = provider.getTracer("test");
    tracer.startSpan("background job").end();
    const { span, request } = startServerSpan(tracer);
    span.end();
    pipeline.handleTransportCompletion(request.record);
    expect(apitallyExporter.getFinishedSpans().map((span) => span.name)).toEqual(["GET /items"]);
    expect(userExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "background job",
      "GET /items",
    ]);
  });

  it("flushes released requests downstream on provider forceFlush and shutdown without tearing down the pipeline", async () => {
    const apitallyExporter = new InMemorySpanExporter();
    const downstream = new BatchSpanProcessor(apitallyExporter, createBatchProcessorOptions());
    const pipeline = new SpanPipeline(downstream);
    setActiveSpanPipeline(pipeline);
    const userProvider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [new ApitallySpanProcessor()],
    });
    const userTracer = userProvider.getTracer("test");

    const first = startServerSpan(userTracer, { name: "GET /first" });
    first.span.end();
    pipeline.handleTransportCompletion(first.request.record);
    expect(apitallyExporter.getFinishedSpans()).toHaveLength(0);
    await userProvider.forceFlush();
    expect(apitallyExporter.getFinishedSpans().map((span) => span.name)).toEqual(["GET /first"]);

    const second = startServerSpan(userTracer, { name: "GET /second" });
    second.span.end();
    pipeline.handleTransportCompletion(second.request.record);
    await userProvider.shutdown();
    expect(apitallyExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "GET /first",
      "GET /second",
    ]);

    const sdkProvider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [pipeline],
    });
    const third = startServerSpan(sdkProvider.getTracer("test"), {
      name: "GET /third",
    });
    third.span.end();
    pipeline.handleTransportCompletion(third.request.record);
    await pipeline.forceFlush();
    expect(apitallyExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "GET /first",
      "GET /second",
      "GET /third",
    ]);
    await pipeline.shutdown();
  });

  it("releases transport-complete requests at shutdown and discards buffers of requests still in flight", async () => {
    const downstream = new CollectingSpanProcessor();
    const { pipeline, tracer } = createTracePipeline({ downstream });
    const completed = startServerSpan(tracer, { name: "GET /completed" });
    tracer
      .startSpan("completed-child", {}, trace.setSpan(completed.request.context, completed.span))
      .end();
    pipeline.handleTransportCompletion(completed.request.record);
    const inFlight = startServerSpan(tracer, { name: "GET /in-flight" });
    tracer
      .startSpan("in-flight-child", {}, trace.setSpan(inFlight.request.context, inFlight.span))
      .end();
    inFlight.span.end();
    expect(downstream.spans).toHaveLength(0);

    await pipeline.shutdown();
    expect(downstream.spans.map((span) => span.name)).toEqual([
      "completed-child",
      "GET /completed",
    ]);
    expect(downstream.spans[1].endTime[0]).toBeGreaterThan(0);

    completed.span.end();
    expect(downstream.spans).toHaveLength(2);
  });
});
