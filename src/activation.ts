import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import {
  BatchLogRecordProcessor,
  type LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  type ApitallyConfig,
  type ApitallyOptions,
  getConfig,
  isApitallyDisabledViaEnv,
  setConfig,
} from "./config.js";
import { ApitallySpanExporter } from "./exporter.js";
import { ExportWorker, type ExportWorkerOptions } from "./exportWorker.js";
import {
  installConsoleCapture,
  installPinoCapture,
  installWinstonCapture,
} from "./logCapture.js";
import { logDebug, logError, logWarning } from "./logger.js";
import { ApitallyLogRecordExporter, LogPipeline } from "./logPipeline.js";
import { MetricsPipeline } from "./metrics.js";
import {
  createLoggerProvider,
  createResource,
  getDistroVersion,
  hasUserTracerProvider,
  resolveEnv,
  setupTracerProvider,
  warnAboutExistingTracerProvider,
} from "./providers.js";
import { Redaction } from "./redaction.js";
import { installSentryEventIdLinkage } from "./sentry.js";
import { SpanPipeline, setActiveSpanPipeline } from "./spanProcessor.js";
import { Spool } from "./spool.js";
import { emitStartupEvent, type StartupEventInfo } from "./startup.js";

// OTel defaults except the schedule delay: the export worker sends every 15
// seconds, so batches only need to reach the spool well within that interval.
const BATCH_SCHEDULE_DELAY_MILLIS = 1_000;
const BATCH_EXPORT_TIMEOUT_MILLIS = 30_000;
const BATCH_MAX_QUEUE_SIZE = 2_048;
const BATCH_MAX_EXPORT_BATCH_SIZE = 512;

// The ESM and CJS builds can both load in one process, so the activation
// singleton lives on globalThis under a Symbol.for key: whichever build copy
// activated, the other copy's entry points observe and reuse the same state.
const ACTIVATION_SLOT_KEY = Symbol.for("apitally.activation");

interface ActivationSlot {
  sdkVersion: string;
  activationAttempted: boolean;
  startupEventInfo?: StartupEventInfo;
  handles?: ActivationHandles;
  runShutdown?: () => Promise<void>;
  shutdownPromise?: Promise<void>;
  beforeExitListener?: () => void;
}

export interface ActivationHandles {
  spanPipeline: SpanPipeline;
  tracerProvider?: NodeTracerProvider;
  loggerProvider: LoggerProvider;
  metricsPipeline: MetricsPipeline;
  spool: Spool;
  worker: ExportWorker;
  undiciInstrumentation?: UndiciInstrumentation;
}

// The synchronous configure step behind useApitally(): records configuration
// only; timers and I/O are deferred to activate().
export function configure(options: ApitallyOptions = {}): ApitallyConfig {
  const config = setConfig(options);
  // User instrumentations constructed after configure read this env var once at
  // init and default to old HTTP semconv names when it is unset; http/dup adds
  // the stable names without changing what a user's existing OpenTelemetry
  // backend receives. A user-set value is respected.
  if (process.env.OTEL_SEMCONV_STABILITY_OPT_IN === undefined) {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "http/dup";
  }
  return config;
}

// Called by the adapters at wrap time; activation emits the startup event from
// the registered info. The first registration wins, so one process emits one
// startup event.
export function registerStartupEventInfo(info: StartupEventInfo): void {
  const slot = getSlot();
  slot.startupEventInfo ??= info;
}

// Called by the adapters' outermost per-request wrapper before the SDK's own
// SERVER span starts. Attempted at most once per process: fully synchronous, so
// the single-threaded event loop guarantees concurrent first requests observe
// either no activation or a completed one.
export function activate(): void {
  const slot = getSlot();
  if (slot.activationAttempted) {
    return;
  }
  slot.activationAttempted = true;
  if (shouldSkipActivation()) {
    return;
  }
  try {
    const handles = startPipelines(slot.startupEventInfo);
    slot.handles = handles;
    slot.runShutdown = () => drainAndStop(handles);
    installBeforeExitHook(slot);
  } catch (error) {
    logError(`Apitally activation failed: ${String(error)}`);
  }
}

export function isActivated(): boolean {
  return getSlot().handles !== undefined;
}

export function getActivationHandles(): ActivationHandles | undefined {
  return getSlot().handles;
}

// Idempotent final drain of all buffered telemetry; a no-op before activation.
// Concurrent calls share one promise, and the beforeExit hook triggers the same
// drain on clean process exits.
export function shutdown(): Promise<void> {
  const slot = getSlot();
  if (!slot.runShutdown) {
    return Promise.resolve();
  }
  slot.shutdownPromise ??= slot.runShutdown();
  return slot.shutdownPromise;
}

// Construction seam for the pieces with I/O side effects; tests substitute
// these to isolate the spool directory and the worker's timing.
export const activationFactories = {
  createSpool: (): Spool => new Spool(),
  createExportWorker: (options: ExportWorkerOptions): ExportWorker =>
    new ExportWorker(options),
};
const defaultFactories = { ...activationFactories };

// Test seam: tears down everything activation started, restores the factories,
// and clears the process-global slot.
export async function resetActivation(): Promise<void> {
  Object.assign(activationFactories, defaultFactories);
  const holder = globalThis as Record<symbol, ActivationSlot | undefined>;
  const slot = holder[ACTIVATION_SLOT_KEY];
  delete holder[ACTIVATION_SLOT_KEY];
  hasWarnedAboutVersionSkew = false;
  if (!slot) {
    return;
  }
  if (slot.beforeExitListener) {
    process.removeListener("beforeExit", slot.beforeExitListener);
  }
  const handles = slot.handles;
  if (!handles) {
    return;
  }
  handles.undiciInstrumentation?.disable();
  await handles.worker.stop();
  await handles.spanPipeline.shutdown();
  await handles.loggerProvider.shutdown();
  await handles.spool.clear();
}

let hasWarnedAboutVersionSkew = false;

function getSlot(): ActivationSlot {
  const holder = globalThis as Record<symbol, ActivationSlot | undefined>;
  const existing = holder[ACTIVATION_SLOT_KEY];
  if (existing) {
    if (
      !hasWarnedAboutVersionSkew &&
      existing.sdkVersion !== getDistroVersion()
    ) {
      hasWarnedAboutVersionSkew = true;
      logWarning(
        `Two copies of the apitally package with different versions (${existing.sdkVersion} and ${getDistroVersion()}) are loaded in this process; version ${existing.sdkVersion} stays active. To resolve this, deduplicate the apitally installation.`,
      );
    }
    return existing;
  }
  const slot: ActivationSlot = {
    sdkVersion: getDistroVersion(),
    activationAttempted: false,
  };
  holder[ACTIVATION_SLOT_KEY] = slot;
  return slot;
}

function shouldSkipActivation(): boolean {
  return (
    Boolean(process.env.JEST_WORKER_ID) ||
    Boolean(process.env.VITEST) ||
    process.env.NODE_ENV === "test" ||
    // The emergency kill switch wins even over an explicit disabled: false option
    isApitallyDisabledViaEnv() ||
    getConfig().disabled
  );
}

function startPipelines(
  startupEventInfo: StartupEventInfo | undefined,
): ActivationHandles {
  const config = getConfig();
  const hasUserProvider = hasUserTracerProvider();
  const env = resolveEnv(hasUserProvider);
  const resource = createResource(env);
  const spool = activationFactories.createSpool();
  const spanExporter = new ApitallySpanExporter({
    redaction: new Redaction(),
    env,
    spool,
    maskRequestBody: config.maskRequestBody,
    maskResponseBody: config.maskResponseBody,
  });
  // Every batch parameter is a concrete value in a fresh object literal per
  // processor: the OTEL_BSP_*/OTEL_BLRP_* env vars apply to omitted or
  // undefined parameters, and the BatchSpanProcessor shim mutates its config.
  const batchSpanProcessor = new BatchSpanProcessor(spanExporter, {
    scheduledDelayMillis: BATCH_SCHEDULE_DELAY_MILLIS,
    exportTimeoutMillis: BATCH_EXPORT_TIMEOUT_MILLIS,
    maxQueueSize: BATCH_MAX_QUEUE_SIZE,
    maxExportBatchSize: BATCH_MAX_EXPORT_BATCH_SIZE,
  });
  const spanPipeline = new SpanPipeline(batchSpanProcessor);
  let tracerProvider: NodeTracerProvider | undefined;
  if (hasUserProvider) {
    warnAboutExistingTracerProvider();
  } else {
    tracerProvider = setupTracerProvider(resource, [spanPipeline]);
  }
  // Published for the ApitallySpanProcessor shell attached to user providers
  setActiveSpanPipeline(spanPipeline);
  // BatchLogRecordProcessor only accepts the single-options-object form; the
  // positional (exporter, config) form constructs a silently broken processor.
  const batchLogProcessor = new BatchLogRecordProcessor({
    exporter: new ApitallyLogRecordExporter(spool),
    scheduledDelayMillis: BATCH_SCHEDULE_DELAY_MILLIS,
    exportTimeoutMillis: BATCH_EXPORT_TIMEOUT_MILLIS,
    maxQueueSize: BATCH_MAX_QUEUE_SIZE,
    maxExportBatchSize: BATCH_MAX_EXPORT_BATCH_SIZE,
  });
  const logPipeline = new LogPipeline(batchLogProcessor, spanPipeline);
  const loggerProvider = createLoggerProvider(resource, [logPipeline]);
  const metricsPipeline = new MetricsPipeline(resource, spool);
  spanPipeline.metricsRecorder = (record) =>
    metricsPipeline.recordFromRequest(record);
  const worker = activationFactories.createExportWorker({
    spool,
    otlpEndpoint: config.otlpEndpoint,
    writeToken: config.writeToken,
    env,
  });
  worker.flushCallbacks.push(
    () => metricsPipeline.collectAndExport(),
    () => batchSpanProcessor.forceFlush(),
    () => batchLogProcessor.forceFlush(),
  );
  if (config.captureLogs) {
    installConsoleCapture(loggerProvider);
    installWinstonCapture(loggerProvider);
    installPinoCapture(loggerProvider);
  }
  installSentryEventIdLinkage();
  let undiciInstrumentation: UndiciInstrumentation | undefined;
  if (!hasUserProvider) {
    // On adopted setups the user's instrumentation set owns client-span
    // production; a second instance would emit duplicate CLIENT spans into
    // the user's exporters.
    undiciInstrumentation = createUndiciInstrumentation(config.otlpEndpoint);
  }
  worker.start();
  if (startupEventInfo) {
    emitStartupEvent(loggerProvider, startupEventInfo);
  }
  return {
    spanPipeline,
    tracerProvider,
    loggerProvider,
    metricsPipeline,
    spool,
    worker,
    undiciInstrumentation,
  };
}

// The ignoreRequestHook is the instrumentation's contract for exempting the
// SDK's own export POSTs; the request origin arrives as string | URL at
// runtime despite the string typing, so it is coerced before parsing.
function createUndiciInstrumentation(
  otlpEndpoint: string,
): UndiciInstrumentation {
  const endpointOrigin = new URL(otlpEndpoint).origin;
  return new UndiciInstrumentation({
    ignoreRequestHook: (request) => {
      try {
        return new URL(String(request.origin)).origin === endpointOrigin;
      } catch {
        return false;
      }
    },
  });
}

// Releases buffered requests whose transport already completed and discards
// the rest, flushes both batch processors into the spool, and sends everything
// pending in one final uncapped cycle.
async function drainAndStop(handles: ActivationHandles): Promise<void> {
  try {
    await handles.spanPipeline.shutdown();
    await handles.loggerProvider.shutdown();
    await handles.worker.finalDrain();
    await handles.worker.stop();
  } catch (error) {
    logWarning(`Error draining telemetry on shutdown: ${String(error)}`);
  }
}

function installBeforeExitHook(slot: ActivationSlot): void {
  if (slot.beforeExitListener) {
    return;
  }
  const listener = () => {
    // Fire-and-forget: the drain's own pending work keeps the event loop alive
    // until it completes, and a repeated beforeExit joins the settled promise.
    void shutdown().catch((error: unknown) => {
      logDebug(`Error draining telemetry on shutdown: ${String(error)}`);
    });
  };
  slot.beforeExitListener = listener;
  process.on("beforeExit", listener);
}
