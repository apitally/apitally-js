import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import SpanCollector from "../../src/common/spanCollector.js";
import { setupOtel, teardownOtel } from "../utils.js";

describe("Span collector", () => {
  afterEach(() => {
    teardownOtel();
  });

  it("Disabled", async () => {
    const collector = new SpanCollector(false);
    expect(collector.enabled).toBe(false);

    setupOtel(collector);

    const spanHandle = collector.startSpan();
    expect(spanHandle.traceId).toBeUndefined();
    await spanHandle.runInContext(async () => {});
    const spans = spanHandle.end();
    expect(spans).toBeUndefined();
  });

  it("Enabled", async () => {
    const collector = new SpanCollector(true);
    expect(collector.enabled).toBe(true);

    setupOtel(collector);

    // Span created outside startSpan() should not be collected
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("outside_span", async (span) => {
      span.end();
    });

    const spanHandle = collector.startSpan();
    await spanHandle.runInContext(async () => {
      // Child span should be collected
      await tracer.startActiveSpan(
        "child_span",
        { kind: SpanKind.CLIENT },
        async (span) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          span.setAttribute("key", "value");
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        },
      );
    });
    spanHandle.setName("named_root");
    const spans = spanHandle.end()!;

    expect(spanHandle.traceId).toBeDefined();
    expect(spans.length).toBe(2);
    expect(spans.some((s) => s.name === "outside_span")).toBe(false);
    expect(spans.some((s) => s.name === "root")).toBe(false);
    expect(
      spans.some((s) => s.name === "named_root" && s.parentSpanId === null),
    ).toBe(true);
    expect(spans.some((s) => s.name === "child_span")).toBe(true);

    const childSpan = spans.find((s) => s.name === "child_span");
    expect(childSpan).toBeDefined();
    expect(childSpan!.kind).toBe("CLIENT");
    expect(childSpan!.attributes).toEqual({ key: "value" });
    expect(childSpan!.status).toBe("OK");
    expect(
      BigInt(childSpan!.endTime) - BigInt(childSpan!.startTime),
    ).toBeGreaterThan(10_000_000n);
  });
});
