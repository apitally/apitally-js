import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Attributes,
  type Context,
  context,
  ROOT_CONTEXT,
  SpanKind,
  TraceFlags,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import type { Resource } from "@opentelemetry/resources";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type LogRecordProcessor,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { vi } from "vitest";
import {
  type ActivationHandles,
  activate,
  activationFactories,
  configure,
  getActivationHandles,
} from "../src/activation.js";
import type { ApitallyOptions } from "../src/config.js";
import {
  CONSUMER_HOLDER_KEY,
  type ConsumerHolder,
  REQUEST_RECORD_KEY,
  type RequestRecord,
  SPAN_HANDLE_KEY,
  type SpanHandle,
} from "../src/context.js";
import { ExportWorker } from "../src/exportWorker.js";
import { LogPipeline } from "../src/logPipeline.js";
import { SpanPipeline } from "../src/spanProcessor.js";
import { Spool } from "../src/spool.js";
import {
  type DecodedLogsRequest,
  type DecodedMetricsRequest,
  type DecodedTraceRequest,
  decodeLogsExport,
  decodeMetricsExport,
  decodeTraceExport,
} from "./stubOtlpServer.js";

export const WRITE_TOKEN = `apt_${"a".repeat(24)}`;

// Activation is guarded against test environments; the global teardown
// restores the cleared markers.
export function clearTestRunnerMarkers(): void {
  delete process.env.VITEST;
  delete process.env.JEST_WORKER_ID;
  delete process.env.NODE_ENV;
}

// Drives configure + activate past the test-environment guards, isolates the
// spool in a fresh temp directory, keeps the worker off its export timer, and
// asserts activation succeeded. The global teardown resets everything it starts.
export function configureAndActivate(
  options: ApitallyOptions = {},
): ActivationHandles {
  clearTestRunnerMarkers();
  // A stray worker cycle must never reach the real ingest endpoint
  process.env.APITALLY_OTLP_ENDPOINT ??= "http://127.0.0.1:1";
  activationFactories.createSpool = () =>
    new Spool(mkdtempSync(join(tmpdir(), "apitally-test-")));
  activationFactories.createExportWorker = (workerOptions) =>
    new ExportWorker({
      ...workerOptions,
      initialExportDelayMillis: 3_600_000,
      requestTimeoutMillis: 2_000,
      interSendPauseMillis: () => 0,
    });
  configure({ writeToken: WRITE_TOKEN, ...options });
  activate();
  const handles = getActivationHandles();
  if (!handles) {
    throw new Error("Apitally activation did not succeed");
  }
  return handles;
}

export interface TracePipeline {
  pipeline: SpanPipeline;
  provider: NodeTracerProvider;
  tracer: Tracer;
  exporter: InMemorySpanExporter;
}

// Downstream processor whose shutdown keeps the collected spans readable, unlike
// InMemorySpanExporter, which clears them.
export class CollectingSpanProcessor implements SpanProcessor {
  readonly spans: ReadableSpan[] = [];
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// A real tracer provider driving the Apitally span pipeline, with an in-memory
// exporter as the default downstream. Extra processors attach alongside the
// pipeline, like user-owned processors on a shared provider.
export function createTracePipeline(
  options: {
    downstream?: SpanProcessor;
    extraSpanProcessors?: SpanProcessor[];
    resource?: Resource;
  } = {},
): TracePipeline {
  const exporter = new InMemorySpanExporter();
  const pipeline = new SpanPipeline(
    options.downstream ?? new SimpleSpanProcessor(exporter),
  );
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    resource: options.resource,
    spanProcessors: [pipeline, ...(options.extraSpanProcessors ?? [])],
  });
  return { pipeline, provider, tracer: provider.getTracer("test"), exporter };
}

export interface LogTestPipeline {
  logPipeline: LogPipeline;
  loggerProvider: LoggerProvider;
  logExporter: InMemoryLogRecordExporter;
}

// The private logger provider driving the Apitally log pipeline, wired to the
// span pipeline for request linkage, with an in-memory exporter as the default
// downstream.
export function createLogPipeline(
  spanPipeline: SpanPipeline,
  downstream?: LogRecordProcessor,
): LogTestPipeline {
  const logExporter = new InMemoryLogRecordExporter();
  const logPipeline = new LogPipeline(
    downstream ?? new SimpleLogRecordProcessor({ exporter: logExporter }),
    spanPipeline,
  );
  const loggerProvider = new LoggerProvider({ processors: [logPipeline] });
  return { logPipeline, loggerProvider, logExporter };
}

// Registers a working context manager so code under test sees the active context.
export function enableAsyncContextManager(): void {
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
}

export interface RequestContext {
  context: Context;
  record: RequestRecord;
  spanHandle: SpanHandle;
  consumerHolder: ConsumerHolder;
}

// The request-scoped holders the transport middleware installs at request entry.
export function createRequestContext(
  base: Context = ROOT_CONTEXT,
): RequestContext {
  const record: RequestRecord = { attributes: {} };
  const spanHandle: SpanHandle = {};
  const consumerHolder: ConsumerHolder = {};
  return {
    context: base
      .setValue(REQUEST_RECORD_KEY, record)
      .setValue(SPAN_HANDLE_KEY, spanHandle)
      .setValue(CONSUMER_HOLDER_KEY, consumerHolder),
    record,
    spanHandle,
    consumerHolder,
  };
}

// Runs fn inside a kept request and completes it, so buffered telemetry releases.
export async function runInsideRequest(
  fixture: { pipeline: SpanPipeline; tracer: Tracer },
  fn: () => void | Promise<void>,
): Promise<Span> {
  const { span, request } = startServerSpan(fixture.tracer);
  await context.with(trace.setSpan(request.context, span), fn);
  span.end();
  fixture.pipeline.handleTransportCompletion(request.record);
  return span;
}

// Starts a SERVER span under a fresh request context, optionally under a sampled
// remote parent so the test picks the trace id.
export function startServerSpan(
  tracer: Tracer,
  options: {
    name?: string;
    attributes?: Attributes;
    traceId?: string;
    consumerHolder?: ConsumerHolder;
  } = {},
): { span: Span; request: RequestContext } {
  const base = options.traceId
    ? trace.setSpanContext(ROOT_CONTEXT, {
        traceId: options.traceId,
        spanId: "0000000000000001",
        isRemote: true,
        traceFlags: TraceFlags.SAMPLED,
      })
    : ROOT_CONTEXT;
  const request = createRequestContext(base);
  if (options.consumerHolder) {
    Object.assign(request.consumerHolder, options.consumerHolder);
  }
  const span = tracer.startSpan(
    options.name ?? "GET /items",
    { kind: SpanKind.SERVER, attributes: options.attributes },
    request.context,
  ) as Span;
  return { span, request };
}

// In-memory spool for export assertions: the missing directory fails the
// writability probe, and captureStderr swallows the fallback warning.
export function createInMemorySpool(): Spool {
  captureStderr();
  return new Spool(join(tmpdir(), `apitally-missing-${randomUUID()}`));
}

// Drains the pipeline into the spool and decodes everything exported so far.
// Accepts anything flushable in front of the spool: a tracer provider or the
// span pipeline itself.
export async function readTraceExportFromSpool(
  provider: { forceFlush(): Promise<void> },
  spool: Spool,
): Promise<DecodedTraceRequest> {
  await provider.forceFlush();
  await spool.closeCurrentFiles();
  const resourceSpans: DecodedTraceRequest["resourceSpans"] = [];
  for (const file of spool.pendingFiles()) {
    resourceSpans.push(
      ...decodeTraceExport(await file.readStoredBytes()).resourceSpans,
    );
  }
  return { resourceSpans };
}

// Drains the log pipeline into the spool and decodes everything exported so far.
export async function readLogsExportFromSpool(
  provider: LoggerProvider,
  spool: Spool,
): Promise<DecodedLogsRequest> {
  await provider.forceFlush();
  await spool.closeCurrentFiles();
  const resourceLogs: DecodedLogsRequest["resourceLogs"] = [];
  for (const file of spool.pendingFiles()) {
    resourceLogs.push(
      ...decodeLogsExport(await file.readStoredBytes()).resourceLogs,
    );
  }
  return { resourceLogs };
}

// Decodes the metrics exported to the spool so far; collection happens before,
// through the metrics pipeline's own collect-and-export entry point.
export async function readMetricsExportFromSpool(
  spool: Spool,
): Promise<DecodedMetricsRequest> {
  await spool.closeCurrentFiles();
  const resourceMetrics: DecodedMetricsRequest["resourceMetrics"] = [];
  for (const file of spool.pendingFiles()) {
    resourceMetrics.push(
      ...decodeMetricsExport(await file.readStoredBytes()).resourceMetrics,
    );
  }
  return { resourceMetrics };
}

// Collects metrics on demand without exporting them anywhere.
export class CollectOnlyMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

// Captures SDK diagnostics written to process.stderr; the global teardown restores the spy.
export function captureStderr(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(
    (chunk: Uint8Array | string) => {
      written.push(chunk.toString());
      return true;
    },
  );
  return written;
}

// Real OTLP protobuf payloads for export tests, built with the same serializers the SDK uses.
export function buildTracePayload(spanName: string): Uint8Array {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.getTracer("test").startSpan(spanName).end();
  return requireSerialized(
    ProtobufTraceSerializer.serializeRequest(exporter.getFinishedSpans()),
  );
}

export function buildLogsPayload(body: string): Uint8Array {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  provider.getLogger("test").emit({ body });
  return requireSerialized(
    ProtobufLogsSerializer.serializeRequest(exporter.getFinishedLogRecords()),
  );
}

export async function buildMetricsPayload(
  metricName: string,
): Promise<Uint8Array> {
  const reader = new CollectOnlyMetricReader();
  const provider = new MeterProvider({ readers: [reader] });
  provider.getMeter("test").createCounter(metricName).add(1);
  const { resourceMetrics } = await reader.collect();
  return requireSerialized(
    ProtobufMetricsSerializer.serializeRequest(resourceMetrics),
  );
}

function requireSerialized(payload: Uint8Array | undefined): Uint8Array {
  if (!payload) {
    throw new Error("Failed to serialize OTLP payload");
  }
  return payload;
}
