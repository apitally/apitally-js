import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import SpanCollector from "../../src/common/spanCollector.js";

describe("Span collector", () => {
  afterEach(async () => {
    context.disable();
    trace.disable();
  });

  it("Disabled", async () => {
    const collector = new SpanCollector(false);
    expect(collector.enabled).toBe(false);

    const { traceId, spans } = await collector.collect(async () => {});
    expect(traceId).toBeUndefined();
    expect(spans).toEqual([]);
  });

  it("Enabled", async () => {
    const collector = new SpanCollector(true);
    expect(collector.enabled).toBe(true);

    // Span created outside collect() should not be collected
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("outside_span", async (span) => {
      span.end();
    });

    const { traceId, spans } = await collector.collect(
      async () => {
        // Child span should be collected
        await tracer.startActiveSpan(
          "child_span",
          { kind: SpanKind.CLIENT },
          async (span) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            span.setAttribute("key", "value");
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
          },
        );
      },
      () => "named_root",
    );

    expect(traceId).toBeDefined();
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
    expect(childSpan!.endTime - childSpan!.startTime).toBeGreaterThan(
      10_000_000,
    );
  });
});
