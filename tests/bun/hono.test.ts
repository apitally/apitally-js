import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { Hono } from "hono";
import {
  type ActivationHandles,
  activate,
  activationFactories,
  getActivationHandles,
  resetActivation,
} from "../../src/activation.js";
import { resetConfig } from "../../src/config.js";
import { ExportWorker } from "../../src/exportWorker.js";
import { useApitally } from "../../src/hono/index.js";
import { uninstallLogCapture } from "../../src/logCapture.js";
import { resetEmittedWarnings } from "../../src/logger.js";
import {
  type SpanPipeline,
  setActiveSpanPipeline,
} from "../../src/spanProcessor.js";
import { Spool } from "../../src/spool.js";
import { resetStartupEventEmitted } from "../../src/startup.js";
import {
  decodedAttributes,
  decodedLogRecords,
  decodedMetrics,
  decodedSpans,
  decodeLogsExport,
  decodeMetricsExport,
  decodeTraceExport,
  PROTO_SPAN_KIND_SERVER,
  StubOtlpServer,
} from "../stubOtlpServer.js";

const WRITE_TOKEN = `apt_${"a".repeat(24)}`;

// Ambient Apitally, OTel, and proxy env vars must not leak into tests.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("APITALLY_") ||
    key.startsWith("OTEL_") ||
    /^(http_proxy|https_proxy|no_proxy)$/i.test(key)
  ) {
    delete process.env[key];
  }
}

const envSnapshot = { ...process.env };

// The bun:test equivalent of the vitest global teardown: process-global state
// is isolated between tests here, by teardown; tests never pre-clean.
afterEach(async () => {
  uninstallLogCapture();
  await resetActivation();
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, envSnapshot);
  resetConfig();
  resetEmittedWarnings();
  resetStartupEventEmitted();
  setActiveSpanPipeline(undefined);
  trace.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  logs.disable();
});

// Activation is guarded against test environments (bun test sets
// NODE_ENV=test), so the markers are cleared, the spool is isolated in a fresh
// temp directory, and the worker stays off its export timer.
function prepareFirstRequestActivation(otlpEndpoint: string): void {
  delete process.env.VITEST;
  delete process.env.JEST_WORKER_ID;
  delete process.env.NODE_ENV;
  process.env.APITALLY_OTLP_ENDPOINT = otlpEndpoint;
  activationFactories.createSpool = () =>
    new Spool(mkdtempSync(join(tmpdir(), "apitally-bun-test-")));
  activationFactories.createExportWorker = (workerOptions) =>
    new ExportWorker({
      ...workerOptions,
      initialExportDelayMillis: 3_600_000,
      requestTimeoutMillis: 2_000,
      interSendPauseMillis: () => 0,
    });
}

function requireActivationHandles(): ActivationHandles {
  const handles = getActivationHandles();
  if (!handles) {
    throw new Error("Apitally is not activated");
  }
  return handles;
}

// Resolves when the span pipeline finishes its next request, composing with
// the log pipeline's release hook.
function waitForNextRequestFinish(pipeline: SpanPipeline): Promise<void> {
  return new Promise((resolve) => {
    const previous = pipeline.onRequestFinished;
    pipeline.onRequestFinished = (serverSpanId, kept) => {
      previous?.(serverSpanId, kept);
      resolve();
    };
  });
}

describe("hono adapter on bun", () => {
  it("delivers spans, logs, and metrics for buffered and streamed responses through the full production assembly to the OTLP endpoint", async () => {
    const stub = await StubOtlpServer.start();
    try {
      prepareFirstRequestActivation(stub.url);
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

      const requestBodyFor = (path: string) => {
        const captured = stub.requests.find(
          (stubRequest) => stubRequest.path === path,
        );
        if (!captured) {
          throw new Error(`No request captured for ${path}`);
        }
        return captured.body;
      };

      const spans = decodedSpans(
        decodeTraceExport(requestBodyFor("/v1/traces")),
      );
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
        decodeLogsExport(requestBodyFor("/v1/logs")),
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
      expect(startupPayload.paths).toContainEqual({
        method: "GET",
        path: "/items/:id",
      });
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
        decodeMetricsExport(requestBodyFor("/v1/metrics")),
      );
      const dataPoints =
        metrics.find((metric) => metric.name === "http.server.request.duration")
          ?.exponentialHistogram?.dataPoints ?? [];
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
