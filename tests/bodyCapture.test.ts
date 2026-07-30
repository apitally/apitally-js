import { describe, expect, it } from "vitest";
import { BodyCapture } from "../src/bodyCapture.js";

describe("bodyCapture", () => {
  it("captures a complete allowed body and resolves the size from the running count", () => {
    const capture = new BodyCapture({
      captureBody: true,
      contentType: "application/json; charset=utf-8",
    });
    capture.addChunk(Buffer.from('{"item'));
    capture.addChunk('s":[]}');
    capture.markComplete();
    expect(capture.body).toEqual(Buffer.from('{"items":[]}'));
    expect(capture.size).toBe(12);
  });

  it("stops buffering while continuing to count observed bytes", () => {
    const capture = new BodyCapture({
      captureBody: true,
      contentType: "application/json",
    });
    capture.addChunk(Buffer.from("kept"));
    capture.stopBuffering();
    capture.addChunk("€");
    capture.markComplete();

    expect(capture.body).toBeUndefined();
    expect(capture.size).toBe(7);
  });

  it.each([
    "application/json",
    "application/problem+json",
    "application/vnd.api+json",
    "application/ld+json",
    "application/x-ndjson",
    "text/markdown",
    "text/plain",
    "application/json; charset=utf-8",
    "Application/JSON",
  ])("captures bodies with content type %j", (contentType) => {
    const capture = new BodyCapture({ captureBody: true, contentType });
    capture.addChunk("body");
    capture.markComplete();
    expect(capture.body).toEqual(Buffer.from("body"));
  });

  it("yields the [BODY_TOO_LARGE] sentinel when the body crosses the size cap", () => {
    const capture = new BodyCapture({
      captureBody: true,
      contentType: "application/json",
    });
    capture.addChunk(Buffer.alloc(30_000, "a"));
    capture.addChunk(Buffer.alloc(30_000, "b"));
    expect(capture.body).toEqual(Buffer.from("[BODY_TOO_LARGE]"));
    capture.markComplete();
    expect(capture.body).toEqual(Buffer.from("[BODY_TOO_LARGE]"));
    expect(capture.size).toBe(60_000);
  });

  it("short-circuits to the sentinel when the declared content length exceeds the cap", () => {
    const capture = new BodyCapture({
      captureBody: true,
      contentType: "application/json",
      contentLength: "60000",
    });
    expect(capture.body).toEqual(Buffer.from("[BODY_TOO_LARGE]"));
    expect(capture.size).toBe(60_000);
  });

  it.each([
    "text/html",
    "application/xml",
    "application/octet-stream",
    "image/png",
    "",
    null,
    undefined,
  ])("does not capture bodies with content type %j but still counts their size", (contentType) => {
    const capture = new BodyCapture({ captureBody: true, contentType });
    capture.addChunk("body");
    capture.markComplete();
    expect(capture.body).toBeUndefined();
    expect(capture.size).toBe(4);
  });

  it("does not capture an empty body", () => {
    const capture = new BodyCapture({
      captureBody: true,
      contentType: "application/json",
    });
    capture.markComplete();
    expect(capture.body).toBeUndefined();
    expect(capture.size).toBe(0);
  });

  it("resolves the size from the declared content length without observing the stream", () => {
    const capture = new BodyCapture({
      captureBody: false,
      contentLength: "1234",
    });
    expect(capture.size).toBe(1234);
  });

  it("counts the size from the observed bytes when the content length is combined with chunked transfer encoding", () => {
    const capture = new BodyCapture({
      captureBody: false,
      contentLength: "999",
      transferEncoding: "chunked",
    });
    capture.addChunk(Buffer.from("abc"));
    expect(capture.size).toBeUndefined();
    capture.markComplete();
    expect(capture.size).toBe(3);
  });

  it("suppresses a partial buffer from an aborted stream and skips the unknown size", () => {
    const capture = new BodyCapture({
      captureBody: true,
      contentType: "application/json",
    });
    capture.addChunk(Buffer.from('{"partial":'));
    expect(capture.body).toBeUndefined();
    expect(capture.size).toBeUndefined();
  });
});
