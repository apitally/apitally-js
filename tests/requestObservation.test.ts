import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { BodyCapture } from "../src/bodyCapture.js";
import type { RequestRecord } from "../src/context.js";
import {
  finalizeRequestObservation,
  finalizeRequestObservationWithError,
  startRequestObservation,
} from "../src/requestObservation.js";
import { drainServerErrors } from "../src/serverErrors.js";
import { drainValidationErrors } from "../src/validationErrors.js";
import {
  configureAndActivate,
  createTracePipeline,
  readActivationSpans,
  readSerializedLogRecords,
  startServerSpan,
} from "./utils.js";

describe("requestObservation", () => {
  it("preserves Node and Web header values for export", async () => {
    configureAndActivate({ captureRequestHeaders: true, captureResponseHeaders: true });
    const { span, request } = startServerSpan(trace.getTracer("test"));
    finalizeRequestObservation({
      observation: {
        requestRecord: request.record,
        spanHandle: request.spanHandle,
        method: "GET",
        startTimeMillis: 0,
      },
      completedAtMillis: performance.now(),
      statusCode: 200,
      requestHeaders: new Headers({ "Content-Type": "application/json" }),
      responseHeaders: {
        "Content-Type": "application/json",
        "Content-Length": 42,
        Vary: ["Accept", "Origin"],
        "X-Undefined": undefined,
      },
    });
    span.end();

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    const headerAttributes = Object.fromEntries(
      Object.entries(spans[0].attributes).filter(([key]) => key.includes(".header.")),
    );
    expect(headerAttributes).toEqual({
      "http.request.header.content-type": ["application/json"],
      "http.response.header.content-type": ["application/json"],
      "http.response.header.content-length": ["42"],
      "http.response.header.vary": ["Accept", "Origin"],
    });
  });

  it("counts a server error only for a 500 response with a captured exception and validation errors only for a 400 or 422 response", () => {
    const { tracer } = createTracePipeline();
    const finalize = (
      statusCode: number,
      state: Partial<RequestRecord>,
      attributes: Attributes = {},
    ) => {
      const { span, request } = startServerSpan(tracer);
      Object.assign(request.record, state);
      Object.assign(request.record.attributes, {
        "apitally.consumer.identifier": "acme",
        ...attributes,
      });
      finalizeRequestObservation({
        observation: {
          requestRecord: request.record,
          spanHandle: request.spanHandle,
          method: "POST",
          startTimeMillis: 0,
        },
        completedAtMillis: 1,
        statusCode,
        route: "/items",
        requestHeaders: {},
        responseHeaders: {},
      });
      span.end();
    };
    const error = new Error("boom");
    const detail = { source: "body", field: "name", message: "Required", type: "invalid_type" };
    finalize(500, { exception: error }, { "apitally.exception.sentry_event_id": "b".repeat(32) });
    finalize(500, {});
    finalize(400, { exception: error, validationErrors: [detail] });
    finalize(422, { validationErrors: [detail], dropReason: "sampled-out" });
    finalize(200, { validationErrors: [detail] });

    expect(drainServerErrors()).toEqual([
      {
        method: "POST",
        path: "/items",
        type: "Error",
        message: "boom",
        stacktrace: error.stack,
        sentry_event_id: "b".repeat(32),
        counts: [{ consumer: "acme", count: 1 }],
      },
    ]);
    expect(drainValidationErrors()).toEqual([
      { method: "POST", path: "/items", ...detail, counts: [{ consumer: "acme", count: 2 }] },
    ]);
  });

  it("emits consumer updates for sampled-out requests and requests finalized with an error", async () => {
    const handles = configureAndActivate();
    finalizeRequestObservation({
      observation: {
        requestRecord: {
          attributes: {},
          dropReason: "sampled-out",
          consumer: { identifier: "acme", name: "Acme", attributes: new Map() },
        },
        spanHandle: {},
        method: "GET",
        startTimeMillis: 0,
      },
      completedAtMillis: 1,
      statusCode: 200,
      route: "/items",
      requestHeaders: {},
      responseHeaders: {},
    });
    finalizeRequestObservationWithError({
      requestRecord: {
        attributes: {},
        consumer: { identifier: "globex", name: "Globex", attributes: new Map() },
      },
      spanHandle: {},
      error: new Error("failed"),
      durationSeconds: 0,
    });
    await handles.loggerProvider.forceFlush();

    expect(readSerializedLogRecords().map((record) => record.body)).toEqual([
      { identifier: "acme", name: "Acme" },
      { identifier: "globex", name: "Globex" },
    ]);
  });

  it("finalizes a request observation with an error by exporting its SERVER span with the exception and an error status", async () => {
    configureAndActivate();
    const { requestRecord, spanHandle } = startTestRequestObservation(ROOT_CONTEXT);

    finalizeRequestObservationWithError({
      requestRecord,
      spanHandle,
      error: new Error("request failed"),
      durationSeconds: 1.25,
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(
      spans[0].events.map((event) => [event.name, event.attributes?.["exception.message"]]),
    ).toEqual([["exception", "request failed"]]);
  });

  it("does not end an adopted span when finalizing an observation with an error", async () => {
    configureAndActivate();
    const adoptedSpan = trace
      .getTracer("user-instrumentation")
      .startSpan("GET", { kind: SpanKind.SERVER });
    const { requestRecord, spanHandle } = startTestRequestObservation(
      trace.setSpan(ROOT_CONTEXT, adoptedSpan),
    );

    finalizeRequestObservationWithError({
      requestRecord,
      spanHandle,
      error: "failed",
      durationSeconds: 0,
    });

    expect(adoptedSpan.isRecording()).toBe(true);
    adoptedSpan.end();
    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].events.map((event) => event.name)).toEqual(["exception"]);
  });
});

function startTestRequestObservation(activeContext: Context) {
  return startRequestObservation({
    activeContext,
    extractedContext: ROOT_CONTEXT,
    tracerName: "test",
    method: "GET",
    startAttributes: { "http.request.method": "GET", "url.path": "/items" },
    requestBodyCapture: new BodyCapture({ captureBody: false }),
  });
}
