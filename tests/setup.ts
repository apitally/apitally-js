import {
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import { afterEach, beforeEach, vi } from "vitest";
import { resetProcessGlobals } from "./harness.js";

beforeEach(() => {
  vi.spyOn(ProtobufTraceSerializer, "serializeRequest");
  vi.spyOn(ProtobufLogsSerializer, "serializeRequest");
  vi.spyOn(ProtobufMetricsSerializer, "serializeRequest");
});

// Process-global state is isolated between tests here, by teardown; tests never pre-clean.
afterEach(async () => {
  // Before restoreAllMocks: capture wraps around spied console methods must
  // unwind first, so the spies are on top when the mocks restore.
  await resetProcessGlobals();
  vi.restoreAllMocks();
});
