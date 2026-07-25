import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
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
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  type DataPoint,
  DataPointType,
  type ExponentialHistogram,
  type ExponentialHistogramMetricData,
  MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
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

export const WRITE_TOKEN = `apt_${"a".repeat(24)}`;

// Tests start no server on this loopback endpoint, so stray sends stay on the host.
export const UNROUTABLE_ENDPOINT = "http://127.0.0.1:1";

// The version expectation is read straight from package.json, independent of
// the SDK's own version resolution under test.
export function readPackageVersion(): string {
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return version;
}

// A one-hour schedule makes forceFlush the only expected drain. Fresh options
// are required because BatchSpanProcessor mutates them.
export function createBatchProcessorOptions() {
  return {
    scheduledDelayMillis: 3_600_000,
    exportTimeoutMillis: 30_000,
    maxQueueSize: 2_048,
    maxExportBatchSize: 512,
  };
}

// Activation is guarded against test environments; the global teardown
// restores the cleared markers.
export function clearTestRunnerMarkers(): void {
  delete process.env.VITEST;
  delete process.env.JEST_WORKER_ID;
  delete process.env.NODE_ENV;
}

// First-request activation tests use an isolated spool and one-hour worker delay
// after removing the test-runner guards.
export function prepareFirstRequestActivation(
  options: ApitallyOptions = {},
): void {
  clearTestRunnerMarkers();
  // A stray worker cycle must never reach the real ingest endpoint.
  process.env.APITALLY_OTLP_ENDPOINT ??= UNROUTABLE_ENDPOINT;
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
}

export function configureAndActivate(
  options: ApitallyOptions = {},
): ActivationHandles {
  prepareFirstRequestActivation(options);
  activate();
  const handles = getActivationHandles();
  if (!handles) {
    throw new Error("Apitally activation did not succeed");
  }
  return handles;
}

export function requireActivationHandles(): ActivationHandles {
  const handles = getActivationHandles();
  if (!handles) {
    throw new Error("Apitally is not activated");
  }
  return handles;
}

export function spyOnSuccessfulFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 200 }));
}

export function readFetchPaths(
  fetchSpy: ReturnType<typeof spyOnSuccessfulFetch>,
): string[] {
  return fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname);
}

export async function withServer(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (server: Server, baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await fn(server, `http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

// Reading the body completes telemetry; one macrotask lets the response tee
// settle before assertions.
export async function readResponseAndSettleTransport(
  response: Response,
): Promise<Buffer> {
  const body = Buffer.from(await response.arrayBuffer());
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  return body;
}

// Used when response completion is not client-observable, such as an aborted
// request; composes with the log release hook.
export function waitForNextRequestFinish(
  pipeline: SpanPipeline,
): Promise<void> {
  return new Promise((resolve) => {
    const previous = pipeline.onRequestFinished;
    pipeline.onRequestFinished = (serverSpanId, kept) => {
      previous?.(serverSpanId, kept);
      resolve();
    };
  });
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

// A real tracer provider drives the pipeline; extra processors model user
// processors on the same provider.
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

// A private logger provider connects to the span pipeline for request linkage.
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

export function readSerializedSpans(): ReadableSpan[] {
  return vi
    .mocked(ProtobufTraceSerializer.serializeRequest)
    .mock.calls.flatMap(([spans]) => spans);
}

export function readSerializedLogRecords(): ReadableLogRecord[] {
  return vi
    .mocked(ProtobufLogsSerializer.serializeRequest)
    .mock.calls.flatMap(([records]) => records);
}

export function readSerializedResourceMetrics(): ResourceMetrics[] {
  return vi
    .mocked(ProtobufMetricsSerializer.serializeRequest)
    .mock.calls.map(([resourceMetrics]) => resourceMetrics);
}

export async function readActivationSpans(): Promise<ReadableSpan[]> {
  const handles = requireActivationHandles();
  await handles.spanPipeline.forceFlush();
  return readSerializedSpans();
}

export async function readActivationDurationDataPoints(): Promise<
  DataPoint<ExponentialHistogram>[]
> {
  const handles = requireActivationHandles();
  await handles.metricsPipeline.collectAndExport();
  return readSerializedResourceMetrics()
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .filter(
      (metric): metric is ExponentialHistogramMetricData =>
        metric.dataPointType === DataPointType.EXPONENTIAL_HISTOGRAM &&
        metric.descriptor.name === "http.server.request.duration",
    )
    .flatMap((metric) => metric.dataPoints);
}

export class CollectOnlyMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

// Global teardown restores the stderr spy.
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
