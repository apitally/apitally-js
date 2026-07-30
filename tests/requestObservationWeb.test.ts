import { describe, expect, it } from "vitest";
import { captureWebResponse } from "../src/requestObservationWeb.js";

function createChunkedResponse(): {
  response: Response;
  pushChunk: (text: string) => void;
  closeStream: () => void;
  errorStream: (error: Error) => void;
} {
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start: (controller) => {
      streamController = controller;
    },
  });
  return {
    response: new Response(source, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    pushChunk: (text) => streamController.enqueue(new TextEncoder().encode(text)),
    closeStream: () => streamController.close(),
    errorStream: (error) => streamController.error(error),
  };
}

function readerFrom(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!response.body) {
    throw new Error("The response has no body stream");
  }
  return response.body.getReader();
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return Buffer.from(value ?? []).toString();
}

describe("requestObservationWeb", () => {
  it("tees a response stream without consuming or delaying it", async () => {
    const { response, pushChunk, closeStream } = createChunkedResponse();
    const captured = captureWebResponse(response, true);
    expect(captured.response.status).toBe(200);
    expect(captured.response.headers.get("content-type")).toBe("application/json");

    const reader = readerFrom(captured.response);
    pushChunk('{"items":');
    expect(await readText(reader)).toBe('{"items":');
    pushChunk("[1,2,3]}");
    closeStream();
    expect(await readText(reader)).toBe("[1,2,3]}");
    expect((await reader.read()).done).toBe(true);

    const result = await captured.completion;
    expect(result.body).toEqual(Buffer.from('{"items":[1,2,3]}'));
    expect(result.size).toBe(17);
    expect(result.completedAtMillis).toBeGreaterThan(0);
  });

  it("suppresses a partial body when the response stream fails", async () => {
    const { response, pushChunk, errorStream } = createChunkedResponse();
    const captured = captureWebResponse(response, true);
    const reader = readerFrom(captured.response);
    pushChunk('{"partial":');
    expect(await readText(reader)).toBe('{"partial":');
    errorStream(new Error("connection reset"));
    await expect(reader.read()).rejects.toThrow("connection reset");

    const result = await captured.completion;
    expect(result.body).toBeUndefined();
    expect(result.size).toBeUndefined();
    expect(result.completedAtMillis).toBeGreaterThan(0);
  });

  it("completes without a body when the response is never read", async () => {
    const response = new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
    const captured = captureWebResponse(response, true, 0);

    const result = await captured.completion;
    expect(result.body).toBeUndefined();
    expect(result.size).toBeUndefined();
    expect(result.completedAtMillis).toBeGreaterThan(0);
  });

  it("completes a bodiless response immediately", async () => {
    const response = new Response(null, { status: 204 });
    const captured = captureWebResponse(response, true);

    expect(captured.response).toBe(response);
    await expect(captured.completion).resolves.toMatchObject({
      size: 0,
      completedAtMillis: expect.any(Number),
    });
  });
});
