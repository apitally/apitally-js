import { EventEmitter } from "node:events";
import { IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BodyCapture } from "../src/bodyCapture.js";
import {
  captureNodeResponse,
  registerServerCloseFlush,
  startNodeRequestObservation,
} from "../src/requestObservationNode.js";
import { captureStderr, configureAndActivate } from "./utils.js";

function createResponse(headers: Record<string, string> = {}): ServerResponse {
  const response = new EventEmitter() as EventEmitter & {
    getHeader(name: string): string | undefined;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  response.getHeader = (name) => headers[name];
  response.write = vi.fn(() => true);
  response.end = vi.fn(() => response);
  return response as unknown as ServerResponse;
}

describe("requestObservationNode", () => {
  it("starts observation without changing request stream flow", () => {
    captureStderr();
    const connection = new PassThrough();
    const request = new IncomingMessage(connection as unknown as Socket);
    request.method = "post";
    request.url = "/items?color=blue";
    request.headers = {
      host: "api.example.com:8443",
      "user-agent": "test-client",
    };

    const started = startNodeRequestObservation({ request, tracerName: "test" });

    expect(request.readableFlowing).toBeNull();
    expect(started.observation.method).toBe("POST");
    expect(started.observation.requestUrl).toBe("/items?color=blue");
    expect(started.observation.requestRecord.attributes).toEqual({
      "http.request.method": "POST",
      "url.path": "/items",
      "url.query": "color=blue",
      "url.scheme": "http",
      "server.address": "api.example.com",
      "url.full": "http://api.example.com:8443/items?color=blue",
      "user_agent.original": "test-client",
    });
  });

  it("captures response writes and request-body state once at finish", async () => {
    const response = createResponse({ "content-type": "application/json" });
    const requestBodyCapture = new BodyCapture({
      captureBody: true,
      contentType: "application/json",
    });
    requestBodyCapture.addChunk('{"request":true}');
    const completion = captureNodeResponse(response, true, requestBodyCapture);

    response.write('{"ok":');
    response.end("true}");
    response.emit("finish");
    requestBodyCapture.markComplete();
    response.emit("close");

    await expect(completion).resolves.toMatchObject({
      body: Buffer.from('{"ok":true}'),
      size: 11,
      completedAtMillis: expect.any(Number),
      responseFinished: true,
      requestBody: { body: undefined, size: undefined },
    });
  });

  it("suppresses a partial response body when close precedes finish", async () => {
    const response = createResponse({ "content-type": "application/json" });
    const completion = captureNodeResponse(response, true);

    response.write('{"partial":');
    response.emit("close");
    response.emit("finish");

    await expect(completion).resolves.toMatchObject({
      body: undefined,
      size: undefined,
      completedAtMillis: expect.any(Number),
      responseFinished: false,
    });
  });

  it("handles a rejected server-close flush", async () => {
    const handles = configureAndActivate();
    const runCycle = vi
      .spyOn(handles.worker, "runCycle")
      .mockRejectedValue(new Error("flush failed"));
    const server = new EventEmitter();
    const request = { socket: { server } } as unknown as IncomingMessage;
    registerServerCloseFlush(request);

    server.emit("close");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runCycle).toHaveBeenCalledOnce();
  });
});
