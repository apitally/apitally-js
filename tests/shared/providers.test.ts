import {
  type Context,
  type ContextManager,
  context,
  createContextKey,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  trace,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CBaggagePropagator } from "@opentelemetry/core";
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { setConfig } from "../../src/config.js";
import {
  createLoggerProvider,
  createMeterProvider,
  createResource,
  hasUserTracerProvider,
  resolveEnv,
  setupTracerProvider,
} from "../../src/providers.js";
import {
  CollectOnlyMetricReader,
  captureStderr,
  readPackageVersion,
  WRITE_TOKEN,
} from "../utils.js";

const UUID_V4_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Mimics a context manager that lost its backing registration, e.g. through
// conflicting @opentelemetry/api copies: context.with() runs but propagates nothing.
class InertContextManager implements ContextManager {
  active(): Context {
    return ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    _context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return fn.call(thisArg, ...args);
  }
  bind<T>(_context: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

describe("providers", () => {
  it("registers its tracer provider globally and records a server span under an unsampled remote parent", () => {
    const exporter = new InMemorySpanExporter();
    setupTracerProvider(createResource("prod"), [
      new SimpleSpanProcessor(exporter),
    ]);

    trace.getTracer("test").startSpan("local root").end();
    const remoteParent = propagation.extract(context.active(), {
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00",
    });
    trace
      .getTracer("test")
      .startSpan("GET /items", { kind: SpanKind.SERVER }, remoteParent)
      .end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans[0].name).toBe("local root");
    expect(spans[1].name).toBe("GET /items");
    expect(spans[1].spanContext().traceId).toBe(
      "0af7651916cd43dd8448eb211c80319c",
    );
    expect(spans[1].parentSpanContext?.spanId).toBe("b7ad6b7169203331");
  });

  it("builds the resource from the OTel environment with the Apitally attributes winning", () => {
    process.env.OTEL_SERVICE_NAME = "test-service";
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "custom.key=custom%20value,deployment.environment.name=production";
    const version = readPackageVersion();

    const resource = createResource("staging");

    expect(resource.attributes["service.name"]).toBe("test-service");
    expect(resource.attributes["custom.key"]).toBe("custom value");
    expect(resource.attributes["service.instance.id"]).toMatch(UUID_V4_FORMAT);
    expect(resource.attributes["deployment.environment.name"]).toBe("staging");
    expect(resource.attributes["telemetry.distro.name"]).toBe("apitally-js");
    expect(resource.attributes["telemetry.distro.version"]).toBe(version);
  });

  it("prefers the configured env over the OTEL_RESOURCE_ATTRIBUTES entry when the SDK sets up the tracer provider", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "deployment.environment.name=production";
    setConfig({ writeToken: WRITE_TOKEN, env: "staging" });
    expect(resolveEnv(false)).toBe("staging");
  });

  it("falls back to the OTEL_RESOURCE_ATTRIBUTES entry when no env is configured", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "deployment.environment.name=production%20eu";
    setConfig({ writeToken: WRITE_TOKEN });
    expect(resolveEnv(false)).toBe("production eu");
  });

  it("prefers the OTEL_RESOURCE_ATTRIBUTES entry with a user tracer provider and warns when a differing configured env loses", () => {
    const lines = captureStderr();
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "deployment.environment.name=production";
    setConfig({ writeToken: WRITE_TOKEN, env: "staging" });
    expect(resolveEnv(true)).toBe("production");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"staging"');
    expect(lines[0]).toContain("production");
  });

  it("uses the OTEL_RESOURCE_ATTRIBUTES entry without a warning when no differing env is configured", () => {
    const lines = captureStderr();
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "deployment.environment.name=production";
    setConfig({ writeToken: WRITE_TOKEN });
    expect(resolveEnv(true)).toBe("production");
    expect(lines).toHaveLength(0);
  });

  it("uses the configured env with a user tracer provider when OTEL_RESOURCE_ATTRIBUTES has no entry", () => {
    setConfig({ writeToken: WRITE_TOKEN, env: "staging" });
    expect(resolveEnv(true)).toBe("staging");
  });

  it("detects a user-registered tracer provider", () => {
    expect(hasUserTracerProvider()).toBe(false);
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    expect(hasUserTracerProvider()).toBe(true);
  });

  it("keeps the meter and logger providers out of the OTel API globals", async () => {
    const resource = createResource("prod");
    const metricReader = new CollectOnlyMetricReader();
    const meterProvider = createMeterProvider(resource, [metricReader]);
    meterProvider.getMeter("apitally").createCounter("test.counter").add(1);
    const logExporter = new InMemoryLogRecordExporter();
    const loggerProvider = createLoggerProvider(resource, [
      new SimpleLogRecordProcessor({ exporter: logExporter }),
    ]);
    loggerProvider.getLogger("apitally").emit({ body: "hello" });

    const { resourceMetrics } = await metricReader.collect();
    expect(resourceMetrics.scopeMetrics).toHaveLength(1);
    expect(resourceMetrics.resource.attributes["service.instance.id"]).toMatch(
      UUID_V4_FORMAT,
    );
    const logRecords = logExporter.getFinishedLogRecords();
    expect(logRecords).toHaveLength(1);
    expect(logRecords[0].body).toBe("hello");
    expect(logRecords[0].resource.attributes["service.instance.id"]).toMatch(
      UUID_V4_FORMAT,
    );

    expect(metrics.getMeterProvider()).not.toBe(meterProvider);
    expect(logs.getLoggerProvider()).not.toBe(loggerProvider);
  });

  it("keeps long span attribute values intact when OTel attribute length limit env vars are set", () => {
    process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT = "100";
    process.env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT = "100";
    const exporter = new InMemorySpanExporter();
    setupTracerProvider(createResource("prod"), [
      new SimpleSpanProcessor(exporter),
    ]);

    const longUrl = `https://example.com/items?q=${"x".repeat(10_000)}`;
    const span = trace.getTracer("test").startSpan("GET /items");
    span.setAttribute("url.full", longUrl);
    span.end();

    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["url.full"]).toBe(longUrl);
  });

  it("leaves a pre-registered user context manager and propagator untouched", () => {
    const lines = captureStderr();
    const userContextManager = new AsyncLocalStorageContextManager();
    userContextManager.enable();
    context.setGlobalContextManager(userContextManager);
    propagation.setGlobalPropagator(new W3CBaggagePropagator());

    setupTracerProvider(createResource("prod"), []);

    const probeKey = createContextKey("test-probe");
    const seenValue = context.with(
      context.active().setValue(probeKey, "value"),
      () => userContextManager.active().getValue(probeKey),
    );
    expect(seenValue).toBe("value");
    expect(propagation.fields()).toEqual(["baggage"]);
    expect(lines).toHaveLength(0);
  });

  it("warns when no context manager wins registration and context propagation is inert", () => {
    const lines = captureStderr();
    context.setGlobalContextManager(new InertContextManager());

    setupTracerProvider(createResource("prod"), []);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("context propagation is not working");
  });
});
