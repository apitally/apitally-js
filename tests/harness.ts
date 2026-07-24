import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  type ActivationHandles,
  activationFactories,
  configure,
  getActivationHandles,
  resetActivation,
} from "../src/activation.js";
import { type ApitallyOptions, resetConfig } from "../src/config.js";
import { ExportWorker } from "../src/exportWorker.js";
import { uninstallLogCapture } from "../src/logCapture.js";
import { resetEmittedWarnings } from "../src/logger.js";
import {
  type SpanPipeline,
  setActiveSpanPipeline,
} from "../src/spanProcessor.js";
import { Spool } from "../src/spool.js";
import { resetStartupEventEmitted } from "../src/startup.js";

// Test helpers shared between the Vitest suites through tests/utils.ts.

export const WRITE_TOKEN = `apt_${"a".repeat(24)}`;

// Nothing listens on port 1, so a stray send fails fast without leaving the host.
export const UNROUTABLE_ENDPOINT = "http://127.0.0.1:1";

// Ambient Apitally, OTel, and proxy env vars must not leak into tests.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("APITALLY_") ||
    key.startsWith("OTEL_") ||
    /^(http_proxy|https_proxy|no_proxy)$/i.test(key)
  ) {
    delete process.env[key];
  }
}

const envSnapshot = { ...process.env };

// The teardown body isolating process-global state between tests; the global
// setups call it from their afterEach hooks.
export async function resetProcessGlobals(): Promise<void> {
  uninstallLogCapture();
  await resetActivation();
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, envSnapshot);
  resetConfig();
  resetEmittedWarnings();
  resetStartupEventEmitted();
  setActiveSpanPipeline(undefined);
  trace.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  logs.disable();
}

// Activation is guarded against test environments; the global teardown
// restores the cleared markers.
export function clearTestRunnerMarkers(): void {
  delete process.env.VITEST;
  delete process.env.JEST_WORKER_ID;
  delete process.env.NODE_ENV;
}

// Configures past the test-environment guards without activating: clears the
// test-runner markers, isolates the spool in a fresh temp directory, and keeps
// the worker off its export timer, so a later activate() call (or a first
// request through an adapter) starts the pipelines under test conditions.
export function prepareFirstRequestActivation(
  options: ApitallyOptions = {},
): void {
  clearTestRunnerMarkers();
  // A stray worker cycle must never reach the real ingest endpoint
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

// Requires activation to have happened, e.g. triggered by an adapter's first
// request after prepareFirstRequestActivation.
export function requireActivationHandles(): ActivationHandles {
  const handles = getActivationHandles();
  if (!handles) {
    throw new Error("Apitally is not activated");
  }
  return handles;
}

// Resolves when the span pipeline finishes its next request, composing with
// the log pipeline's release hook. Used where response completion is not
// observable from the client side, e.g. an aborted request.
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
