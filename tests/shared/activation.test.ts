import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activate,
  activationFactories,
  configure,
  getActivationHandles,
  isActivated,
  registerStartupEventInfo,
  shutdown,
} from "../../src/activation.js";
import type { ApitallyOptions } from "../../src/config.js";
import { getActiveSpanPipeline } from "../../src/spanProcessor.js";
import {
  decodedLogRecords,
  decodedSpans,
  decodeTraceExport,
  PROTO_SPAN_KIND_CLIENT,
  PROTO_SPAN_KIND_SERVER,
  StubOtlpServer,
  spanNames,
} from "../stubOtlpServer.js";
import {
  captureStderr,
  clearTestRunnerMarkers,
  configureAndActivate,
  readLogsExportFromSpool,
  readTraceExportFromSpool,
  runInsideRequest,
  UNROUTABLE_ENDPOINT,
  WRITE_TOKEN,
} from "../utils.js";

describe("activation", () => {
  let server: StubOtlpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("activates once across back-to-back activate calls and emits one startup event from the first registered app info", async () => {
    registerStartupEventInfo({
      framework: "express",
      resolvePaths: () => [],
    });
    registerStartupEventInfo({
      framework: "hono",
      resolvePaths: () => [],
    });
    const handles = configureAndActivate();
    activate();

    expect(getActivationHandles()).toBe(handles);
    expect(getActiveSpanPipeline()).toBe(handles.spanPipeline);
    const records = decodedLogRecords(
      await readLogsExportFromSpool(handles.loggerProvider, handles.spool),
    );
    expect(records).toHaveLength(1);
    expect(records[0].eventName).toBe("apitally.app.startup");
    const payload = JSON.parse(records[0].body?.stringValue ?? "") as {
      framework: string;
    };
    expect(payload.framework).toBe("express");
  });

  it("sets the semconv opt-in env var at configure when it is unset", () => {
    configure({ writeToken: WRITE_TOKEN });
    expect(process.env.OTEL_SEMCONV_STABILITY_OPT_IN).toBe("http/dup");
  });

  it("respects a user-set semconv opt-in env var at configure", () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "http";
    configure({ writeToken: WRITE_TOKEN });
    expect(process.env.OTEL_SEMCONV_STABILITY_OPT_IN).toBe("http");
  });

  it("produces client spans for outgoing requests through its own pipeline when it set up the tracer provider", async () => {
    server = await StubOtlpServer.start();
    const handles = configureAndActivate();
    const tracer = trace.getTracer("test");
    await runInsideRequest(
      { pipeline: handles.spanPipeline, tracer },
      async () => {
        const response = await fetch(`${server?.url}/external`);
        await response.arrayBuffer();
      },
    );

    const spans = decodedSpans(
      await readTraceExportFromSpool(handles.spanPipeline, handles.spool),
    );
    expect(spans.map((span) => [span.name, span.kind])).toEqual([
      ["GET", PROTO_SPAN_KIND_CLIENT],
      ["GET /items", PROTO_SPAN_KIND_SERVER],
    ]);
  });

  it("leaves client span production to the user when attaching to an existing tracer provider", async () => {
    server = await StubOtlpServer.start();
    captureStderr();
    const userExporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(userExporter)],
      }),
    );
    const handles = configureAndActivate();
    const response = await fetch(`${server.url}/external`);
    await response.arrayBuffer();

    expect(userExporter.getFinishedSpans()).toHaveLength(0);
    const spans = decodedSpans(
      await readTraceExportFromSpool(handles.spanPipeline, handles.spool),
    );
    expect(spans).toEqual([]);
  });

  const guardCases: {
    guard: string;
    prepare: () => void;
    options: ApitallyOptions;
  }[] = [
    {
      guard: "JEST_WORKER_ID",
      prepare: () => {
        process.env.JEST_WORKER_ID = "1";
      },
      options: {},
    },
    {
      guard: "VITEST",
      prepare: () => {
        process.env.VITEST = "true";
      },
      options: {},
    },
    {
      guard: "NODE_ENV=test",
      prepare: () => {
        process.env.NODE_ENV = "test";
      },
      options: {},
    },
    {
      guard: "APITALLY_DISABLED",
      prepare: () => {
        process.env.APITALLY_DISABLED = "true";
      },
      options: { disabled: false },
    },
    {
      guard: "the disabled option",
      prepare: () => {},
      options: { disabled: true },
    },
  ];

  it.each(guardCases)(
    "skips activation permanently for $guard",
    ({ prepare, options }) => {
      clearTestRunnerMarkers();
      process.env.APITALLY_OTLP_ENDPOINT = UNROUTABLE_ENDPOINT;
      prepare();
      configure({ writeToken: WRITE_TOKEN, ...options });
      activate();
      expect(isActivated()).toBe(false);
      expect(getActivationHandles()).toBeUndefined();

      clearTestRunnerMarkers();
      delete process.env.APITALLY_DISABLED;
      activate();
      expect(isActivated()).toBe(false);
    },
  );

  it("logs an error and keeps serving untelemetered when activation fails", () => {
    const lines = captureStderr();
    clearTestRunnerMarkers();
    process.env.APITALLY_OTLP_ENDPOINT = UNROUTABLE_ENDPOINT;
    activationFactories.createSpool = () => {
      throw new Error("no spool");
    };
    configure({ writeToken: WRITE_TOKEN });
    activate();

    expect(isActivated()).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[Apitally ERROR] Apitally activation failed");

    activate();
    expect(isActivated()).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it("shares one activation and shutdown with a second module copy through the process-global state", async () => {
    server = await StubOtlpServer.start();
    process.env.APITALLY_OTLP_ENDPOINT = server.url;
    registerStartupEventInfo({ framework: "hono", resolvePaths: () => [] });
    const handles = configureAndActivate();

    vi.resetModules();
    const secondCopy = await import("../../src/activation.js");
    expect(secondCopy.activate).not.toBe(activate);
    secondCopy.configure({ writeToken: WRITE_TOKEN });
    secondCopy.activate();

    expect(secondCopy.isActivated()).toBe(true);
    expect(secondCopy.getActivationHandles()?.spanPipeline).toBe(
      handles.spanPipeline,
    );
    const records = decodedLogRecords(
      await readLogsExportFromSpool(handles.loggerProvider, handles.spool),
    );
    expect(records).toHaveLength(1);
    expect(records[0].eventName).toBe("apitally.app.startup");

    await secondCopy.shutdown();
    expect(server.paths()).toEqual(["/v1/logs", "/v1/metrics"]);
  });

  it("keeps log capture installed once when a second module copy loads", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const handles = configureAndActivate();

    vi.resetModules();
    const secondCopy = await import("../../src/activation.js");
    secondCopy.configure({ writeToken: WRITE_TOKEN });
    secondCopy.activate();

    const tracer = trace.getTracer("test");
    await runInsideRequest({ pipeline: handles.spanPipeline, tracer }, () => {
      console.info("captured once");
    });
    const records = decodedLogRecords(
      await readLogsExportFromSpool(handles.loggerProvider, handles.spool),
    );
    expect(records).toHaveLength(1);
    expect(records[0].body?.stringValue).toBe("captured once");
  });

  it("warns once when a second module copy has a different version", async () => {
    const lines = captureStderr();
    configureAndActivate();
    const slot = (globalThis as Record<symbol, { sdkVersion: string }>)[
      Symbol.for("apitally.activation")
    ];
    slot.sdkVersion = "0.9.0";

    vi.resetModules();
    const secondCopy = await import("../../src/activation.js");
    secondCopy.activate();
    secondCopy.activate();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("0.9.0");
  });

  it("resolves shutdown before activation without effect", async () => {
    await shutdown();
    expect(isActivated()).toBe(false);
  });

  it("drains pending exports on shutdown exactly once across repeated calls", async () => {
    server = await StubOtlpServer.start();
    process.env.APITALLY_OTLP_ENDPOINT = server.url;
    registerStartupEventInfo({ framework: "express", resolvePaths: () => [] });
    const handles = configureAndActivate();
    const tracer = trace.getTracer("test");
    await runInsideRequest(
      { pipeline: handles.spanPipeline, tracer },
      () => {},
    );

    const drain = shutdown();
    expect(shutdown()).toBe(drain);
    await drain;
    expect(server.paths()).toEqual(["/v1/traces", "/v1/logs", "/v1/metrics"]);
    expect(spanNames(decodeTraceExport(server.requests[0].body))).toEqual([
      "GET /items",
    ]);

    await shutdown();
    expect(server.paths()).toEqual(["/v1/traces", "/v1/logs", "/v1/metrics"]);
  });

  it("drains buffered telemetry when the process emits beforeExit", async () => {
    server = await StubOtlpServer.start();
    process.env.APITALLY_OTLP_ENDPOINT = server.url;
    configureAndActivate();

    process.emit("beforeExit", 0);
    await shutdown();
    expect(server.paths()).toEqual(["/v1/metrics"]);
  });
});
