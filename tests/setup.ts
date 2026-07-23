import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { resetEmittedWarnings } from "../src/logger.js";

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

// Process-global state is isolated between tests here, by teardown; tests never pre-clean.
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, envSnapshot);
  resetConfig();
  resetEmittedWarnings();
  trace.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  logs.disable();
});
