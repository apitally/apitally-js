import { fileURLToPath } from "node:url";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { instrument, span } from "../../src/tracing.js";
import {
  createTracePipeline,
  enableAsyncContextManager,
  runInsideRequest,
  type TracePipeline,
} from "../utils.js";

// Manual tracing uses the global tracer API, so the provider registers globally.
function createTracingFixture(): TracePipeline {
  enableAsyncContextManager();
  const fixture = createTracePipeline();
  trace.setGlobalTracerProvider(fixture.provider);
  return fixture;
}

function getExportedSpan(fixture: TracePipeline, name: string): ReadableSpan {
  const exportedSpan = fixture.exporter
    .getFinishedSpans()
    .find((finishedSpan) => finishedSpan.name === name);
  if (!exportedSpan) {
    throw new Error(`The span "${name}" was not exported`);
  }
  return exportedSpan;
}

// The file and line of this call's next source line, parsed from its own stack
// frame so the expectation survives the test runner's code transforms.
function callSiteOfNextLine(): { filePath: string; lineNumber: number } {
  const frame = (new Error().stack ?? "").split("\n")[2] ?? "";
  const match = /at (?:.*\()?(.*?):(\d+):\d+\)?$/.exec(frame);
  if (!match) {
    throw new Error(`Could not parse the call site from: ${frame}`);
  }
  return {
    filePath: match[1].startsWith("file://")
      ? fileURLToPath(match[1])
      : match[1],
    lineNumber: Number(match[2]) + 1,
  };
}

describe("tracing", () => {
  it("wraps a function in an INTERNAL child span named after it, with its code location from wrap time", async () => {
    const fixture = createTracingFixture();
    const wrapSite = callSiteOfNextLine();
    const wrapped = instrument(function fetchItems(count: number) {
      return count * 2;
    });
    let result: number | undefined;
    const serverSpan = await runInsideRequest(fixture, () => {
      result = wrapped(21);
    });
    expect(result).toBe(42);
    expect(fixture.exporter.getFinishedSpans()).toHaveLength(2);
    const childSpan = getExportedSpan(fixture, "fetchItems");
    expect(childSpan.kind).toBe(SpanKind.INTERNAL);
    expect(childSpan.instrumentationScope.name).toBe("apitally.otel");
    expect(childSpan.parentSpanContext?.spanId).toBe(
      serverSpan.spanContext().spanId,
    );
    expect(childSpan.attributes).toEqual({
      "code.function.name": "fetchItems",
      "code.file.path": wrapSite.filePath,
      "code.line.number": wrapSite.lineNumber,
    });
  });

  it("names the span after the given name when instrument is called with one", async () => {
    const fixture = createTracingFixture();
    const wrapped = instrument("load items", function loadItemsFromDb() {
      return 7;
    });
    await runInsideRequest(fixture, () => {
      wrapped();
    });
    const childSpan = getExportedSpan(fixture, "load items");
    expect(childSpan.attributes["code.function.name"]).toBe("loadItemsFromDb");
  });

  it("runs a span() block inside a nested INTERNAL span under the active context, returning the block's value", async () => {
    const fixture = createTracingFixture();
    const wrapped = instrument(function handleJob() {
      return span("process step", () => 7);
    });
    let result: number | undefined;
    await runInsideRequest(fixture, () => {
      result = wrapped();
    });
    expect(result).toBe(7);
    expect(fixture.exporter.getFinishedSpans()).toHaveLength(3);
    const outerSpan = getExportedSpan(fixture, "handleJob");
    const innerSpan = getExportedSpan(fixture, "process step");
    expect(innerSpan.kind).toBe(SpanKind.INTERNAL);
    expect(innerSpan.instrumentationScope.name).toBe("apitally.otel");
    expect(innerSpan.parentSpanContext?.spanId).toBe(
      outerSpan.spanContext().spanId,
    );
    expect(innerSpan.attributes).toEqual({});
  });

  it("ends an async function's span when the returned promise resolves, passing the value through", async () => {
    const fixture = createTracingFixture();
    const wrapped = instrument(async function loadUser() {
      await Promise.resolve();
      return "jane";
    });
    let result: string | undefined;
    await runInsideRequest(fixture, async () => {
      result = await wrapped();
    });
    expect(result).toBe("jane");
    const childSpan = getExportedSpan(fixture, "loadUser");
    expect(childSpan.status.code).toBe(SpanStatusCode.UNSET);
    expect(childSpan.events).toEqual([]);
  });

  it("records an async function's rejection as the span exception, passing the rejection through", async () => {
    const fixture = createTracingFixture();
    const failure = new Error("boom");
    const wrapped = instrument(async function failLoading() {
      await Promise.resolve();
      throw failure;
    });
    await runInsideRequest(fixture, async () => {
      await expect(wrapped()).rejects.toBe(failure);
    });
    const childSpan = getExportedSpan(fixture, "failLoading");
    expect(childSpan.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(childSpan.events).toHaveLength(1);
    expect(childSpan.events[0].name).toBe("exception");
    expect(childSpan.events[0].attributes?.["exception.type"]).toBe("Error");
    expect(childSpan.events[0].attributes?.["exception.message"]).toBe("boom");
  });

  it("rethrows a synchronous throw after recording it on the span", async () => {
    const fixture = createTracingFixture();
    const failure = new Error("boom");
    const wrapped = instrument(function failFast(): never {
      throw failure;
    });
    await runInsideRequest(fixture, () => {
      expect(() => wrapped()).toThrow(failure);
    });
    const childSpan = getExportedSpan(fixture, "failFast");
    expect(childSpan.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(childSpan.events.map((event) => event.name)).toEqual(["exception"]);
  });
});
