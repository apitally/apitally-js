import { describe, expect, it } from "vitest";
import { addServerError, drainServerErrors } from "../src/serverErrors.js";

describe("serverErrors", () => {
  it("aggregates identical exceptions per consumer, method, and route with the latest Sentry event id", () => {
    class OrderFailedError extends Error {}
    const error = new OrderFailedError("boom");
    addServerError(undefined, "get", "/items", error, undefined);
    addServerError(undefined, "GET", "/items", error, "a".repeat(32));
    addServerError("acme", "GET", "/items", "string failure", undefined);
    addServerError(undefined, "OPTIONS", "/items", error, undefined);
    addServerError(undefined, "GET", "", error, undefined);

    expect(drainServerErrors()).toEqual([
      {
        method: "GET",
        path: "/items",
        type: "OrderFailedError",
        message: "boom",
        stacktrace: error.stack,
        count: 2,
        sentry_event_id: "a".repeat(32),
      },
      {
        consumer: "acme",
        method: "GET",
        path: "/items",
        type: "",
        message: "string failure",
        stacktrace: "",
        count: 1,
      },
    ]);
    expect(drainServerErrors()).toEqual([]);
  });

  it("truncates a long message and keeps the head of a long stacktrace", () => {
    const error = new Error("m".repeat(3_000));
    error.stack = [
      "Error: boom",
      ...Array.from({ length: 2_000 }, (_, index) => `    at frame${index} (file.js:${index}:1)`),
    ].join("\n");
    addServerError(undefined, "GET", "/items", error, undefined);

    const [group] = drainServerErrors();
    expect(group.message).toBe(`${"m".repeat(2_048 - "... (truncated)".length)}... (truncated)`);
    const stacktrace = group.stacktrace as string;
    expect(stacktrace.length).toBeLessThanOrEqual(65_536);
    expect(stacktrace.startsWith("Error: boom\n    at frame0 (file.js:0:1)\n")).toBe(true);
    expect(stacktrace.endsWith("\n... (truncated) ...")).toBe(true);
  });
});
