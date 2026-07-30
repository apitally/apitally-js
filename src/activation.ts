import { isMainThread } from "node:worker_threads";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { BatchLogRecordProcessor, type LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, type Span } from "@opentelemetry/sdk-trace-base";
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  type ApitallyConfig,
  type ApitallyOptions,
  getConfig,
  isApitallyDisabledViaEnv,
  setConfig,
} from "./config.js";
import { ExportWorker, type ExportWorkerOptions } from "./exportWorker.js";
import { installConsoleCapture, installPinoCapture, installWinstonCapture } from "./logCapture.js";
import { logDebug, logError, logWarning } from "./logger.js";
import { ApitallyLogRecordExporter } from "./logRecordExporter.js";
import { ApitallyLogRecordProcessor } from "./logRecordProcessor.js";
import { MetricsPipeline } from "./metrics.js";
import { getDistroVersion } from "./packageVersion.js";
import {
  createLoggerProvider,
  resolveEnvAndCreateResource,
  setupTracerProvider,
} from "./providers.js";
import { Redaction } from "./redaction.js";
import { installSentryEventIdRecording } from "./sentry.js";
import { ApitallySpanExporter } from "./spanExporter.js";
import {
  isApitallySpanProcessorDeclared,
  SpanPipeline,
  setActiveSpanPipeline,
  setServerSpanActivationCallback,
} from "./spanProcessor.js";
import { Spool } from "./spool.js";
import { emitStartupEvent, type StartupEventInfo } from "./startup.js";

// The worker sends every 15 seconds, so batches only need to reach the spool
// within that interval.
const BATCH_SCHEDULE_DELAY_MILLIS = 1_000;
const BATCH_EXPORT_TIMEOUT_MILLIS = 30_000;
const BATCH_MAX_QUEUE_SIZE = 2_048;
const BATCH_MAX_EXPORT_BATCH_SIZE = 512;
const BATCH_MAX_EXPORT_BATCH_SIZE_WITH_BODY_CAPTURE = 32;
const SIGNAL_FLUSH_TIMEOUT_MILLIS = 5_000;

type TerminationSignal = "SIGTERM" | "SIGINT";
type SignalListeners = Record<TerminationSignal, () => void>;

// The ESM and CJS builds can load together, so a Symbol.for key gives both
// copies the same activation state.
const ACTIVATION_STATE_KEY = Symbol.for("apitally.activation");

interface ActivationState {
  sdkVersion: string;
  activationAttempted: boolean;
  startupEventInfo?: StartupEventInfo;
  handles?: ActivationHandles;
  runShutdown?: () => Promise<void>;
  shutdownPromise?: Promise<void>;
  beforeExitListener?: () => void;
  signalListeners?: SignalListeners;
  signalDrainPromise?: Promise<void>;
}

interface ActivationHandles {
  spanPipeline: SpanPipeline;
  tracerProvider?: NodeTracerProvider;
  loggerProvider: LoggerProvider;
  metricsPipeline: MetricsPipeline;
  spool: Spool;
  worker: ExportWorker;
  undiciInstrumentation?: UndiciInstrumentation;
}

// Configuration stays synchronous; activate() defers timers and I/O.
export function configure(options: ApitallyOptions = {}): ApitallyConfig {
  const config = setConfig(options);
  // User instrumentations read this at initialization. `http/dup` adds stable
  // HTTP attributes alongside legacy ones; a user-set value takes precedence.
  if (process.env.OTEL_SEMCONV_STABILITY_OPT_IN === undefined) {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "http/dup";
  }
  setServerSpanActivationCallback(activate);
  return config;
}

// The first adapter registration wins so one process emits one startup event.
export function registerStartupEventInfo(info: StartupEventInfo): void {
  const activationState = getActivationState();
  activationState.startupEventInfo ??= info;
}

// Activation is synchronous and attempted once, so concurrent first requests
// observe either no activation or completed activation.
export function activate(triggeringSpan?: Span): void {
  const activationState = getActivationState();
  if (activationState.activationAttempted) {
    return;
  }
  activationState.activationAttempted = true;
  if (shouldSkipActivation()) {
    return;
  }
  try {
    const handles = startPipelines(activationState.startupEventInfo, triggeringSpan);
    activationState.handles = handles;
    activationState.runShutdown = () => drainAndStop(handles);
    installBeforeExitHook(activationState);
    installSignalHooks(activationState);
  } catch (error) {
    logError(`Apitally activation failed: ${String(error)}`);
  }
}

export function isActivated(): boolean {
  return getActivationState().handles !== undefined;
}

export function getActivationHandles(): ActivationHandles | undefined {
  return getActivationState().handles;
}

// Concurrent calls and lifecycle hooks share one final drain; calls before
// activation are no-ops.
export function shutdown(): Promise<void> {
  const activationState = getActivationState();
  const handles = activationState.handles;
  const runShutdown = activationState.runShutdown;
  if (!handles || !runShutdown) {
    return Promise.resolve();
  }
  if (!activationState.shutdownPromise) {
    removeLifecycleHooks(activationState);
    const signalDrainPromise = activationState.signalDrainPromise;
    activationState.shutdownPromise = (
      signalDrainPromise
        ? signalDrainPromise.then(() => handles.worker.waitForIdle())
        : Promise.resolve()
    ).then(runShutdown);
  }
  return activationState.shutdownPromise;
}

// Tests replace these factories to isolate spool files and worker timing.
export const activationFactories = {
  createSpool: (): Spool => new Spool(),
  createExportWorker: (options: ExportWorkerOptions): ExportWorker => new ExportWorker(options),
};
const defaultFactories = { ...activationFactories };

// Tests reset process-global activation and its side effects between cases.
export async function resetActivation(): Promise<void> {
  Object.assign(activationFactories, defaultFactories);
  const holder = globalThis as Record<symbol, ActivationState | undefined>;
  const activationState = holder[ACTIVATION_STATE_KEY];
  delete holder[ACTIVATION_STATE_KEY];
  hasWarnedAboutVersionSkew = false;
  if (!activationState) {
    return;
  }
  removeLifecycleHooks(activationState);
  const handles = activationState.handles;
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

function getActivationState(): ActivationState {
  const holder = globalThis as Record<symbol, ActivationState | undefined>;
  const existing = holder[ACTIVATION_STATE_KEY];
  if (existing) {
    if (!hasWarnedAboutVersionSkew && existing.sdkVersion !== getDistroVersion()) {
      hasWarnedAboutVersionSkew = true;
      logWarning(
        `Two copies of the apitally package with different versions (${existing.sdkVersion} and ${getDistroVersion()}) are loaded in this process; version ${existing.sdkVersion} stays active. To resolve this, deduplicate the apitally installation.`,
      );
    }
    return existing;
  }
  const activationState: ActivationState = {
    sdkVersion: getDistroVersion(),
    activationAttempted: false,
  };
  holder[ACTIVATION_STATE_KEY] = activationState;
  return activationState;
}

function shouldSkipActivation(): boolean {
  return (
    Boolean(process.env.JEST_WORKER_ID) ||
    Boolean(process.env.VITEST) ||
    process.env.NODE_ENV === "test" ||
    // The emergency kill switch overrides an explicit disabled: false option.
    isApitallyDisabledViaEnv() ||
    getConfig().disabled
  );
}

function startPipelines(
  startupEventInfo: StartupEventInfo | undefined,
  triggeringSpan?: Span,
): ActivationHandles {
  const config = getConfig();
  let hasUserProvider = isApitallySpanProcessorDeclared();
  const { env, resource } = resolveEnvAndCreateResource(hasUserProvider, triggeringSpan?.resource);
  const spool = activationFactories.createSpool();
  const spanExporter = new ApitallySpanExporter({
    redaction: new Redaction(),
    env,
    spool,
    maskRequestBody: config.maskRequestBody,
    maskResponseBody: config.maskResponseBody,
  });
  // Concrete options prevent OTel environment variables from changing batch
  // behavior. Each processor gets a fresh object because its config is mutated.
  const batchSpanProcessor = new BatchSpanProcessor(spanExporter, {
    scheduledDelayMillis: BATCH_SCHEDULE_DELAY_MILLIS,
    exportTimeoutMillis: BATCH_EXPORT_TIMEOUT_MILLIS,
    maxQueueSize: BATCH_MAX_QUEUE_SIZE,
    maxExportBatchSize:
      config.captureRequestBody || config.captureResponseBody
        ? BATCH_MAX_EXPORT_BATCH_SIZE_WITH_BODY_CAPTURE
        : BATCH_MAX_EXPORT_BATCH_SIZE,
  });
  const spanPipeline = new SpanPipeline(batchSpanProcessor);
  let tracerProvider: NodeTracerProvider | undefined;
  if (!hasUserProvider) {
    tracerProvider = setupTracerProvider(resource, [spanPipeline]);
    if (!tracerProvider) {
      hasUserProvider = true;
      logWarning(
        "Apitally could not register its OpenTelemetry tracer provider because another provider is already registered. Only metrics and the startup event are sent to Apitally until you add ApitallySpanProcessor (exported by the apitally package) to your tracer provider's spanProcessors constructor option or the NodeSDK spanProcessors option.",
      );
    }
  }
  setActiveSpanPipeline(spanPipeline);
  // BatchLogRecordProcessor requires its single-options-object form; positional
  // arguments create a broken processor.
  const batchLogProcessor = new BatchLogRecordProcessor({
    exporter: new ApitallyLogRecordExporter(spool),
    scheduledDelayMillis: BATCH_SCHEDULE_DELAY_MILLIS,
    exportTimeoutMillis: BATCH_EXPORT_TIMEOUT_MILLIS,
    maxQueueSize: BATCH_MAX_QUEUE_SIZE,
    maxExportBatchSize: BATCH_MAX_EXPORT_BATCH_SIZE,
  });
  const logRecordProcessor = new ApitallyLogRecordProcessor(batchLogProcessor, spanPipeline);
  const loggerProvider = createLoggerProvider(resource, [logRecordProcessor]);
  const metricsPipeline = new MetricsPipeline(resource, spool);
  spanPipeline.metricsRecorder = (record) => metricsPipeline.recordFromRequest(record);
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
  installSentryEventIdRecording();
  let undiciInstrumentation: UndiciInstrumentation | undefined;
  if (!hasUserProvider) {
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

// ignoreRequestHook prevents telemetry for export POSTs. The request origin can
// be a string or URL at runtime despite its string type.
function createUndiciInstrumentation(otlpEndpoint: string): UndiciInstrumentation {
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

function installSignalHooks(activationState: ActivationState): void {
  if (process.platform === "win32" || !isMainThread) {
    return;
  }
  let listeners: SignalListeners;
  listeners = {
    SIGTERM: () => handleTerminationSignal(activationState, listeners, "SIGTERM"),
    SIGINT: () => handleTerminationSignal(activationState, listeners, "SIGINT"),
  };
  activationState.signalListeners = listeners;
  try {
    process.prependOnceListener("SIGTERM", listeners.SIGTERM);
    process.prependOnceListener("SIGINT", listeners.SIGINT);
  } catch (error) {
    removeSignalHooks(activationState, listeners);
    logWarning(`Unable to install Apitally signal handlers: ${String(error)}`);
  }
}

function handleTerminationSignal(
  activationState: ActivationState,
  listeners: SignalListeners,
  signal: TerminationSignal,
): void {
  const hasApplicationListener = process
    .listeners(signal)
    .some((listener) => listener !== listeners[signal]);
  removeSignalHooks(activationState, listeners);
  const drainPromise = flushAfterTerminationSignal(activationState, signal, hasApplicationListener);
  activationState.signalDrainPromise = drainPromise;
  void drainPromise.catch((error: unknown) => {
    logDebug(`Error flushing telemetry on ${signal}: ${String(error)}`);
  });
}

async function flushAfterTerminationSignal(
  activationState: ActivationState,
  signal: TerminationSignal,
  hasApplicationListener: boolean,
): Promise<void> {
  const handles = activationState.handles;
  if (!handles) {
    return;
  }
  try {
    if (activationState.shutdownPromise) {
      await waitForSignalDeadline(activationState.shutdownPromise);
    } else {
      await handles.worker.finalDrain(SIGNAL_FLUSH_TIMEOUT_MILLIS);
    }
  } catch (error) {
    logDebug(`Error flushing telemetry on ${signal}: ${String(error)}`);
  }
  if (hasApplicationListener || process.listeners(signal).length > 0) {
    return;
  }
  const exitCode = signal === "SIGTERM" ? 143 : 130;
  if (process.platform === "linux" && process.pid === 1) {
    process.exit(exitCode);
  }
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(exitCode);
  }
}

async function waitForSignalDeadline(promise: Promise<void>): Promise<void> {
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadlineReached = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, SIGNAL_FLUSH_TIMEOUT_MILLIS);
  });
  try {
    await Promise.race([promise, deadlineReached]);
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
  }
}

function removeSignalHooks(
  activationState: ActivationState,
  listeners = activationState.signalListeners,
): void {
  if (!listeners) {
    return;
  }
  process.removeListener("SIGTERM", listeners.SIGTERM);
  process.removeListener("SIGINT", listeners.SIGINT);
  if (activationState.signalListeners === listeners) {
    activationState.signalListeners = undefined;
  }
}

function removeLifecycleHooks(activationState: ActivationState): void {
  removeSignalHooks(activationState);
  if (activationState.beforeExitListener) {
    process.removeListener("beforeExit", activationState.beforeExitListener);
    activationState.beforeExitListener = undefined;
  }
}

function installBeforeExitHook(activationState: ActivationState): void {
  const listener = () => {
    // The drain keeps the event loop alive until shutdown settles.
    void shutdown().catch((error: unknown) => {
      logDebug(`Error draining telemetry on shutdown: ${String(error)}`);
    });
  };
  activationState.beforeExitListener = listener;
  process.on("beforeExit", listener);
}
