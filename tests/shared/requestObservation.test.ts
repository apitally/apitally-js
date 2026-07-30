import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import type { RequestRecord, SpanHandle } from "../../src/context.js";
import {
  finalizeFailedRequestDispatch,
  finalizeRecordAndReleaseRequest,
  resolveHttpRequestStartAttributes,
} from "../../src/requestObservation.js";

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

  it("finalizes a failed dispatch through the current span and exact owned span", () => {
    const recordException = vi.fn();
    const setStatus = vi.fn();
    const end = vi.fn();
    const currentSpan = { isRecording: () => true, recordException } as unknown as Span;
    const ownSpan = { setStatus, end } as unknown as Span;
    const requestRecord: RequestRecord = { attributes: {} };
    const spanHandle: SpanHandle = { span: currentSpan, ownSpan };
    const error = new Error("dispatch failed");

    finalizeFailedRequestDispatch({
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

    finalizeRecordAndReleaseRequest({
      requestRecord: { attributes: {} },
      spanHandle: { span: currentSpan, ownSpan },
      method: "GET",
      durationSeconds: 0.25,
      statusCode: 500,
      route: "/items/:id",
      requestHeaders: {},
      responseHeaders: {},
    });

    expect(setCurrentAttribute).toHaveBeenCalledWith("http.response.status_code", 500);
    expect(setCurrentAttribute).toHaveBeenCalledWith("http.route", "/items/:id");
    expect(currentSpan.updateName).not.toHaveBeenCalled();
    expect(currentSpan.setStatus).not.toHaveBeenCalled();
    expect(currentSpan.end).not.toHaveBeenCalled();
    expect(updateOwnedName).toHaveBeenCalledWith("GET /items/:id");
    expect(setOwnedStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(endOwnedSpan).toHaveBeenCalledOnce();
  });

  it("does not end an adopted span after a failed dispatch", () => {
    const recordException = vi.fn();
    const adoptedSpan = {
      isRecording: () => true,
      recordException,
      end: vi.fn(),
    } as unknown as Span;

    finalizeFailedRequestDispatch({
      requestRecord: { attributes: {} },
      spanHandle: { span: adoptedSpan },
      error: "failed",
      durationSeconds: 0,
    });

    expect(recordException).toHaveBeenCalledOnce();
    expect(adoptedSpan.end).not.toHaveBeenCalled();
  });
});
