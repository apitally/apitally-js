import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { activate } from "../../src/activation.js";
import { useApitally } from "../../src/hono/index.js";
import {
  prepareFirstRequestActivation,
  requireActivationHandles,
  resetProcessGlobals,
  WRITE_TOKEN,
  waitForNextRequestFinish,
} from "../harness.js";
import {
  decodedAttributes,
  decodedLogRecords,
  decodedMetrics,
  decodedSpans,
  decodeLogsExport,
  decodeMetricsExport,
  decodeTraceExport,
  durationDataPoints,
  PROTO_SPAN_KIND_SERVER,
  StubOtlpServer,
} from "../stubOtlpServer.js";

// The bun:test equivalent of the vitest global teardown: process-global state
// is isolated between tests here, by teardown; tests never pre-clean.
afterEach(async () => {
  await resetProcessGlobals();
});

describe("hono adapter on bun", () => {
  it("delivers spans, logs, and metrics for buffered and streamed responses through the full production assembly to the OTLP endpoint", async () => {
    const stub = await StubOtlpServer.start();
    try {
      process.env.APITALLY_OTLP_ENDPOINT = stub.url;
      prepareFirstRequestActivation({ captureResponseBody: true });
      const app = new Hono();
      useApitally(app, {
        writeToken: WRITE_TOKEN,
        captureResponseBody: true,
      });
      app.get("/items/:id", (c) => {
        console.log("processing item");
        return c.json({ id: Number(c.req.param("id")), name: "Widget" });
      });
      app.get("/stream", (c) => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("chunk-1\n"));
            controller.enqueue(encoder.encode("chunk-2\n"));
            controller.enqueue(encoder.encode("chunk-3\n"));
            controller.close();
          },
        });
        return c.newResponse(body, 200, { "content-type": "text/plain" });
      });
      activate();
      const handles = requireActivationHandles();

      let released = waitForNextRequestFinish(handles.spanPipeline);
      const itemsResponse = await app.request("/items/11");
      expect(itemsResponse.status).toBe(200);
      expect(await itemsResponse.json()).toEqual({ id: 11, name: "Widget" });
      await released;

      released = waitForNextRequestFinish(handles.spanPipeline);
      const streamResponse = await app.request("/stream");
      expect(streamResponse.status).toBe(200);
      expect(await streamResponse.text()).toBe("chunk-1\nchunk-2\nchunk-3\n");
      await released;

      await handles.worker.runCycle();
      await stub.waitForRequests(3);

      const spans = decodedSpans(decodeTraceExport(stub.bodyFor("/v1/traces")));
      expect(spans.map((span) => [span.name, span.kind])).toEqual([
        ["GET /items/:id", PROTO_SPAN_KIND_SERVER],
        ["GET /stream", PROTO_SPAN_KIND_SERVER],
      ]);
      const itemsAttributes = decodedAttributes(spans[0].attributes);
      expect(itemsAttributes["http.route"]).toBe("/items/:id");
      expect(itemsAttributes["http.response.status_code"]).toBe(200);
      const streamAttributes = decodedAttributes(spans[1].attributes);
      expect(streamAttributes["http.route"]).toBe("/stream");
      expect(streamAttributes["http.response.body.size"]).toBe(24);
      expect(streamAttributes["apitally.response.body"]).toBe(
        "chunk-1\nchunk-2\nchunk-3\n",
      );

      const logRecords = decodedLogRecords(
        decodeLogsExport(stub.bodyFor("/v1/logs")),
      );
      expect(logRecords).toHaveLength(2);
      const startupRecord = logRecords.find(
        (record) => record.eventName === "apitally.app.startup",
      );
      expect(startupRecord).toBeDefined();
      const startupPayload = JSON.parse(
        startupRecord?.body?.stringValue ?? "",
      ) as { framework: string; paths: { method: string; path: string }[] };
      expect(startupPayload.framework).toBe("hono");
      expect(startupPayload.paths).toEqual([
        { method: "GET", path: "/items/:id" },
        { method: "GET", path: "/stream" },
      ]);
      const consoleRecord = logRecords.find(
        (record) => record.eventName !== "apitally.app.startup",
      );
      expect(consoleRecord?.body?.stringValue).toBe("processing item");
      const itemsSpanId = Buffer.from(spans[0].spanId ?? []).toString("hex");
      expect(
        decodedAttributes(consoleRecord?.attributes ?? [])[
          "apitally.request.server_span_id"
        ],
      ).toBe(itemsSpanId);

      const metrics = decodedMetrics(
        decodeMetricsExport(stub.bodyFor("/v1/metrics")),
      );
      const dataPoints = durationDataPoints(metrics);
      expect(dataPoints).toHaveLength(2);
      expect(
        dataPoints.map((dataPoint) => [
          decodedAttributes(dataPoint.attributes)["http.route"],
          dataPoint.count,
        ]),
      ).toEqual([
        ["/items/:id", 1],
        ["/stream", 1],
      ]);
    } finally {
      await stub.close();
    }
  });
});
