import { describe, expect, it } from "vitest";
import { BodyCapture, normalizeHeaders } from "../src/capture.js";

describe("capture", () => {
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

  it("normalizes header records and web headers to lowercase names keeping multi-value semantics", () => {
    expect(
      normalizeHeaders({
        "Content-Type": "application/json",
        "Content-Length": 42,
        "Set-Cookie": ["a=1", "b=2"],
        "X-Undefined": undefined,
      }),
    ).toEqual({
      "content-type": "application/json",
      "content-length": "42",
      "set-cookie": ["a=1", "b=2"],
    });

    const webHeaders = new Headers({ "Content-Type": "application/json" });
    webHeaders.append("Set-Cookie", "a=1");
    webHeaders.append("Set-Cookie", "b=2");
    expect(normalizeHeaders(webHeaders)).toEqual({
      "content-type": "application/json",
      "set-cookie": ["a=1", "b=2"],
    });
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

  it("does not capture a body with a disallowed content type but still counts the size", () => {
    const capture = new BodyCapture({
      captureBody: true,
      contentType: "text/html",
    });
    capture.addChunk(Buffer.from("<html></html>"));
    capture.markComplete();
    expect(capture.body).toBeUndefined();
    expect(capture.size).toBe(13);
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
