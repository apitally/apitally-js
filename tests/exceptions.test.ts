import { context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { captureException, coerceToException } from "../src/exceptions.js";
import { createTracePipeline, enableAsyncContextManager, startServerSpan } from "./utils.js";

describe("exceptions", () => {
  it("records captureException events on the server span", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      captureException(new Error("request failed"));
      captureException(42);
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.events).toHaveLength(2);
    expect(exported.events[0].name).toBe("exception");
    expect(exported.events[0].attributes?.["exception.type"]).toBe("Error");
    expect(exported.events[0].attributes?.["exception.message"]).toBe("request failed");
    expect(exported.events[1].attributes?.["exception.message"]).toBe("42");
  });

  it("records a custom Error subclass by its constructor name", () => {
    class OrderFailedError extends Error {}

    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      captureException(new OrderFailedError("request failed"));
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.events[0].attributes?.["exception.type"]).toBe("OrderFailedError");
  });

  it("coerces a string error to an exception string", () => {
    expect(coerceToException("boom")).toBe("boom");
  });

  it("coerces a non-Error, non-object value to a string", () => {
    expect(coerceToException(42)).toBe("42");
  });

  it("passes an object error through unchanged", () => {
    const error = { message: "custom" };
    expect(coerceToException(error)).toBe(error);
  });

  it("treats captureException as a safe no-op outside a request", () => {
    const { exporter } = createTracePipeline();
    expect(() => {
      captureException(new Error("boom"));
    }).not.toThrow();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
