import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodedAttributes } from "../stubOtlpServer.js";
import {
  configureAndActivate,
  prepareFirstRequestActivation,
  readActivationSpans,
  waitForNextRequestFinish,
} from "../utils.js";
import { buildAppFixture } from "./app.js";

describe("hono adapter over @hono/node-server", () => {
  let app: Hono;
  let server: ServerType;
  let serverPort: number;

  beforeAll(async () => {
    // The fixture's useApitally call resolves the same configuration the first
    // test configures, so the first-call-wins rule never sees a conflict.
    prepareFirstRequestActivation({ captureResponseBody: true });
    app = buildAppFixture({ captureResponseBody: true });
    await new Promise<void>((resolve) => {
      server = serve(
        { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
        (info: AddressInfo) => {
          serverPort = info.port;
          resolve();
        },
      );
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("reports correct sizes and completes transport at the last byte of a streamed response over a real socket", async () => {
    const handles = configureAndActivate({ captureResponseBody: true });
    const released = waitForNextRequestFinish(handles.spanPipeline);
    const response = await fetch(`http://127.0.0.1:${serverPort}/stream`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("chunk-1\nchunk-2\nchunk-3\n");
    await released;

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /stream");
    const attributes = decodedAttributes(spans[0].attributes);
    expect(attributes["http.response.body.size"]).toBe(24);
    expect(attributes["apitally.response.body"]).toBe(
      "chunk-1\nchunk-2\nchunk-3\n",
    );
  });

  it("releases an aborted request through the close path with the partial response body suppressed", async () => {
    const handles = configureAndActivate({ captureResponseBody: true });
    const released = waitForNextRequestFinish(handles.spanPipeline);
    const socket = connect(serverPort, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      "GET /stream?hold=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
    );
    await once(socket, "data");
    socket.destroy();
    await released;

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /stream");
    const attributes = decodedAttributes(spans[0].attributes);
    expect(attributes["apitally.response.body"]).toBeUndefined();
    expect(attributes["http.response.body.size"]).toBeUndefined();
  });
});
