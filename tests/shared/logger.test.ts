import { describe, expect, it } from "vitest";
import { logDebug, logError, logWarning } from "../../src/logger.js";
import { captureStderr } from "../utils.js";

describe("logger", () => {
  it("emits warnings and errors to stderr", () => {
    const lines = captureStderr();
    logWarning("something is degraded");
    logError("something failed");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("something is degraded");
    expect(lines[1]).toContain("something failed");
  });

  it("emits a repeated warning only once", () => {
    const lines = captureStderr();
    logWarning("same warning");
    logWarning("same warning");
    logWarning("different warning");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("same warning");
    expect(lines[1]).toContain("different warning");
  });

  it("emits repeated errors every time", () => {
    const lines = captureStderr();
    logError("same error");
    logError("same error");
    expect(lines).toHaveLength(2);
  });

  it("emits debug output only when APITALLY_DEBUG is set", () => {
    const lines = captureStderr();
    logDebug("hidden debug message");
    expect(lines).toHaveLength(0);
    process.env.APITALLY_DEBUG = "1";
    logDebug("visible debug message");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("visible debug message");
  });
});
