import { afterEach, vi } from "vitest";
import { resetProcessGlobals } from "./harness.js";

// Process-global state is isolated between tests here, by teardown; tests never pre-clean.
afterEach(async () => {
  // Before restoreAllMocks: capture wraps around spied console methods must
  // unwind first, so the spies are on top when the mocks restore.
  await resetProcessGlobals();
  vi.restoreAllMocks();
});
