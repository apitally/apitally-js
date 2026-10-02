import { describe, expect, it } from "vitest";
import { addServerError, drainServerErrors } from "../src/serverErrors.js";

describe("serverErrors", () => {
  it("aggregates identical exceptions per method and route with per-consumer counts and the latest Sentry event id", () => {
    class OrderFailedError extends Error {}
    const error = new OrderFailedError("boom");
    addServerError(undefined, "get", "/items", error, undefined);
    addServerError(undefined, "GET", "/items", error, "a".repeat(32));
    addServerError("acme", "GET", "/items", error, undefined);
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
        sentry_event_id: "a".repeat(32),
        counts: [{ count: 2 }, { consumer: "acme", count: 1 }],
      },
      {
        method: "GET",
        path: "/items",
        type: "",
        message: "string failure",
        stacktrace: "",
        counts: [{ consumer: "acme", count: 1 }],
      },
    ]);
    expect(drainServerErrors()).toEqual([]);
  });

  it("keeps at most 100 distinct errors and keeps counting retained errors for new consumers", () => {
    for (let index = 0; index < 101; index++) {
      addServerError(undefined, "GET", "/items", String(index), undefined);
    }
    const consumers = Array.from({ length: 101 }, (_, index) => `consumer-${index}`);
    for (const consumer of consumers) {
      addServerError(consumer, "GET", "/items", "0", undefined);
    }

    const errors = drainServerErrors();
    expect(errors).toHaveLength(100);
    expect(errors[0].counts).toEqual([
      { count: 1 },
      ...consumers.map((consumer) => ({ consumer, count: 1 })),
    ]);
  });

  it("truncates a long message and keeps the head of a long stacktrace", () => {
    const error = new Error("m".repeat(3_000));
    error.stack = [
      "Error: boom",
      ...Array.from({ length: 2_000 }, (_, index) => `    at frame${index} (file.js:${index}:1)`),
    ].join("\n");
    addServerError(undefined, "GET", "/items", error, undefined);

    const [serverError] = drainServerErrors();
    expect(serverError.message).toBe(
      `${"m".repeat(2_048 - "... (truncated)".length)}... (truncated)`,
    );
    const stacktrace = serverError.stacktrace as string;
    expect(stacktrace.length).toBeLessThanOrEqual(65_536);
    expect(stacktrace.startsWith("Error: boom\n    at frame0 (file.js:0:1)\n")).toBe(true);
    expect(stacktrace.endsWith("\n... (truncated) ...")).toBe(true);
  });
});
