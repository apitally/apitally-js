import { context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { setRequestAttribute } from "../src/requestAttributes.js";
import { createTracePipeline, enableAsyncContextManager, startServerSpan } from "./utils.js";

describe("requestAttributes", () => {
  it("writes setRequestAttribute through to the server span and request record", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      setRequestAttribute("custom.key", "value");
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["custom.key"]).toBe("value");
    expect(request.record.attributes["custom.key"]).toBe("value");
  });

  it("is a safe no-op outside a request", () => {
    const { exporter } = createTracePipeline();
    expect(() => setRequestAttribute("custom.key", "value")).not.toThrow();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
