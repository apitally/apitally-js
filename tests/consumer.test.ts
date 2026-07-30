import { context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { setConsumer } from "../src/consumer.js";
import { createTracePipeline, enableAsyncContextManager, startServerSpan } from "./utils.js";

describe("consumer", () => {
  it("normalizes and caps identifier, name, and group written through setConsumer", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      setConsumer({
        identifier: `  ${"i".repeat(200)}  `,
        name: `  ${"n".repeat(100)}  `,
        group: `  ${"g".repeat(100)}  `,
      });
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["apitally.consumer.identifier"]).toBe("i".repeat(128));
    expect(exported.attributes["apitally.consumer.name"]).toBe("n".repeat(64));
    expect(exported.attributes["apitally.consumer.group"]).toBe("g".repeat(64));
    expect(request.record.attributes["apitally.consumer.identifier"]).toBe("i".repeat(128));
  });

  it("converts a runtime numeric identifier to a string", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      setConsumer(123 as unknown as string);
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["apitally.consumer.identifier"]).toBe("123");
  });

  it("writes only the identifier when name and group are absent", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      setConsumer("  acme-corp  ");
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["apitally.consumer.identifier"]).toBe("acme-corp");
    expect(exported.attributes["apitally.consumer.name"]).toBeUndefined();
    expect(exported.attributes["apitally.consumer.group"]).toBeUndefined();
  });

  it("produces no consumer attributes for a missing, empty, or invalid identifier", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    for (const consumer of ["", "   ", {} as never, { identifier: "  " } as never]) {
      const { span, request } = startServerSpan(tracer);
      context.with(trace.setSpan(request.context, span), () => {
        setConsumer(consumer);
      });
      span.end();
      pipeline.handleTransportCompletion(request.record);
    }
    for (const span of exporter.getFinishedSpans()) {
      expect(span.attributes["apitally.consumer.identifier"]).toBeUndefined();
    }
  });

  it("is a safe no-op outside a request", () => {
    const { exporter } = createTracePipeline();
    expect(() => setConsumer("tenant-1")).not.toThrow();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
