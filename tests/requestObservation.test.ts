import { type Attributes, type Span, SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { setConfig } from "../src/config.js";
import type { RequestRecord, SpanHandle } from "../src/context.js";
import {
  finalizeRequestObservation,
  finalizeRequestObservationWithError,
  resolveHttpRequestStartAttributes,
} from "../src/requestObservation.js";
import { drainServerErrors } from "../src/serverErrors.js";
import { type SpanCopy, setActiveSpanPipeline } from "../src/spanProcessor.js";
import { drainValidationErrors } from "../src/validationErrors.js";
import {
  CollectingSpanProcessor,
  createTracePipeline,
  startServerSpan,
  WRITE_TOKEN,
} from "./utils.js";

describe("requestObservation", () => {
  it("maps normalized HTTP request metadata and omits only undefined values", () => {
    expect(
      resolveHttpRequestStartAttributes({
        method: "POST",
        path: "/items",
        query: "",
        scheme: "https",
        serverAddress: "api.example.com",
        fullUrl: "https://api.example.com/items?",
        clientAddress: "",
        userAgent: "",
        requestBodySize: 0,
      }),
    ).toEqual({
      "http.request.method": "POST",
      "url.path": "/items",
      "url.query": "",
      "url.scheme": "https",
      "server.address": "api.example.com",
      "url.full": "https://api.example.com/items?",
      "client.address": "",
      "user_agent.original": "",
      "http.request.body.size": 0,
    });
  });

  it("preserves Node and Web header values for export", () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      captureRequestHeaders: true,
      captureResponseHeaders: true,
    });
    const downstream = new CollectingSpanProcessor();
    const { pipeline, tracer } = createTracePipeline({ downstream });
    setActiveSpanPipeline(pipeline);
    const { span, request } = startServerSpan(tracer);
    const requestHeaders = new Headers({ "Content-Type": "application/json" });
    requestHeaders.append("Set-Cookie", "a=1");
    requestHeaders.append("Set-Cookie", "b=2");

    finalizeRequestObservation({
      observation: {
        requestRecord: request.record,
        spanHandle: request.spanHandle,
        method: "GET",
        startTimeMillis: 0,
      },
      completedAtMillis: performance.now(),
      statusCode: 200,
      requestHeaders,
      responseHeaders: {
        "Content-Type": "application/json",
        "Content-Length": 42,
        "Set-Cookie": ["a=1", "b=2"],
        "X-Undefined": undefined,
      },
    });
    span.end();

    expect(downstream.spans).toHaveLength(1);
    expect((downstream.spans[0] as SpanCopy).apitallyData?.stash).toEqual({
      requestHeaders: {
        "content-type": "application/json",
        "set-cookie": ["a=1", "b=2"],
      },
      responseHeaders: {
        "content-type": "application/json",
        "content-length": "42",
        "set-cookie": ["a=1", "b=2"],
      },
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
        consumer: "acme",
        method: "POST",
        path: "/items",
        type: "Error",
        message: "boom",
        stacktrace: error.stack,
        count: 1,
        sentry_event_id: "b".repeat(32),
      },
    ]);
    expect(drainValidationErrors()).toEqual([
      { consumer: "acme", method: "POST", path: "/items", ...detail, count: 2 },
    ]);
  });

  it("finalizes a request observation with an error through the current span and exact owned span", () => {
    const recordException = vi.fn();
    const setStatus = vi.fn();
    const end = vi.fn();
    const currentSpan = { isRecording: () => true, recordException } as unknown as Span;
    const ownSpan = { setStatus, end } as unknown as Span;
    const requestRecord: RequestRecord = { attributes: {} };
    const spanHandle: SpanHandle = { span: currentSpan, ownSpan };
    const error = new Error("request failed");

    finalizeRequestObservationWithError({
      requestRecord,
      spanHandle,
      error,
      durationSeconds: 1.25,
    });

    expect(requestRecord.durationSeconds).toBe(1.25);
    expect(recordException).toHaveBeenCalledWith(error);
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(end).toHaveBeenCalledOnce();
  });

  it("writes to the current span while finalizing only the owned span", () => {
    const setCurrentAttribute = vi.fn();
    const currentSpan = {
      isRecording: () => true,
      setAttribute: setCurrentAttribute,
      updateName: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    } as unknown as Span;
    const updateOwnedName = vi.fn();
    const setOwnedStatus = vi.fn();
    const endOwnedSpan = vi.fn();
    const ownSpan = {
      isRecording: () => true,
      updateName: updateOwnedName,
      setStatus: setOwnedStatus,
      end: endOwnedSpan,
    } as unknown as Span;

    finalizeRequestObservation({
      observation: {
        requestRecord: { attributes: {} },
        spanHandle: { span: currentSpan, ownSpan },
        method: "GET",
        startTimeMillis: 0,
      },
      completedAtMillis: 250,
      statusCode: 500,
      route: "/items/:id",
      clientAddress: "8.8.8.8",
      requestHeaders: {},
      responseHeaders: {},
    });

    expect(setCurrentAttribute).toHaveBeenCalledWith("client.address", "8.8.8.8");
    expect(setCurrentAttribute).toHaveBeenCalledWith("http.response.status_code", 500);
    expect(setCurrentAttribute).toHaveBeenCalledWith("http.route", "/items/:id");
    expect(currentSpan.updateName).not.toHaveBeenCalled();
    expect(currentSpan.setStatus).not.toHaveBeenCalled();
    expect(currentSpan.end).not.toHaveBeenCalled();
    expect(updateOwnedName).toHaveBeenCalledWith("GET /items/:id");
    expect(setOwnedStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(endOwnedSpan).toHaveBeenCalledWith(250);
  });

  it("does not end an adopted span when finalizing an observation with an error", () => {
    const recordException = vi.fn();
    const adoptedSpan = {
      isRecording: () => true,
      recordException,
      end: vi.fn(),
    } as unknown as Span;

    finalizeRequestObservationWithError({
      requestRecord: { attributes: {} },
      spanHandle: { span: adoptedSpan },
      error: "failed",
      durationSeconds: 0,
    });

    expect(recordException).toHaveBeenCalledOnce();
    expect(adoptedSpan.end).not.toHaveBeenCalled();
  });
});
