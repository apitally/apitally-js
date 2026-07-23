import { once } from "node:events";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import {
  type Attributes,
  context,
  SpanKind,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { getRPCMetadata, type RPCMetadata, RPCType } from "@opentelemetry/core";
import compression from "compression";
import express, { type Express } from "express";
import express4 from "express4";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isActivated } from "../../src/activation.js";
import { useApitally } from "../../src/express/index.js";
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
import {
  captureStderr,
  configureAndActivate,
  prepareFirstRequestActivation,
  readActivationDurationDataPoints,
  readActivationSpans,
  readTraceExportFromSpool,
  requireActivationHandles,
  WRITE_TOKEN,
  waitForNextRequestFinish,
  withServer,
} from "../utils.js";
import { buildAppFixture } from "./app.js";

// Assembled at module scope, before any capture patch is installed, like a
// route module loaded ahead of the SDK in an app without the register import.
const preAssembledRouter = express.Router();
preAssembledRouter.get("/pre/:id", (_req, res) => {
  res.json({ pre: true });
});

describe("express adapter", () => {
  let app: Express;
  let server: ReturnType<typeof createServer>;
  let serverPort: number;

  beforeAll(async () => {
    // The fixture's useApitally call resolves the same configuration the first
    // test configures, so the first-call-wins rule never sees a conflict.
    prepareFirstRequestActivation();
    app = buildAppFixture();
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    serverPort = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("exports one SERVER span per request with stable semconv attributes and the {method} {route} span name", async () => {
    prepareFirstRequestActivation();
    const response = await request(server).get("/items/42?color=blue");
    expect(response.status).toBe(200);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(PROTO_SPAN_KIND_SERVER);
    const attributes = decodedAttributes(spans[0].attributes);
    expect(attributes["http.response.header.content-type"]).toEqual([
      "application/json; charset=utf-8",
    ]);
    for (const key of Object.keys(attributes)) {
      if (key.startsWith("http.response.header.")) {
        delete attributes[key];
      }
    }
    expect(attributes).toEqual({
      "http.request.method": "GET",
      "url.path": "/items/42",
      "url.query": "color=blue",
      "url.scheme": "http",
      "url.full": `http://127.0.0.1:${serverPort}/items/42?color=blue`,
      "server.address": "127.0.0.1",
      "client.address": "127.0.0.1",
      "http.route": "/items/:id",
      "http.response.status_code": 200,
      "http.response.body.size": Buffer.byteLength(
        JSON.stringify({ id: 42, name: "Widget" }),
      ),
    });
  });

  it("continues the remote trace from a traceparent header and exports the request even when the upstream trace is unsampled", async () => {
    prepareFirstRequestActivation();
    const sampledTraceId = "0af7651916cd43dd8448eb211c80319c";
    const unsampledTraceId = "1bf7651916cd43dd8448eb211c80319d";
    const parentSpanId = "b7ad6b7169203331";
    await request(server)
      .get("/items/1")
      .set("traceparent", `00-${sampledTraceId}-${parentSpanId}-01`)
      .expect(200);
    await request(server)
      .get("/items/2")
      .set("traceparent", `00-${unsampledTraceId}-${parentSpanId}-00`)
      .expect(200);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(2);
    const traceIds = spans.map((span) =>
      Buffer.from(span.traceId ?? []).toString("hex"),
    );
    expect(traceIds).toEqual([sampledTraceId, unsampledTraceId]);
    for (const span of spans) {
      expect(Buffer.from(span.parentSpanId ?? []).toString("hex")).toBe(
        parentSpanId,
      );
    }
  });

  it("includes mount prefixes in route templates for nested routers and exports unmatched requests with a cleared route skipped by the request metrics", async () => {
    const lines = captureStderr();
    prepareFirstRequestActivation();
    await request(server).get("/api/nested/abc").expect(200);
    await request(server).get("/api/v2/deep").expect(200);
    await request(server).get("/nope").expect(404);

    const spans = await readActivationSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "GET /api/nested/:key",
      "GET /api/v2/deep",
      "GET",
    ]);
    const unmatchedAttributes = decodedAttributes(spans[2].attributes);
    expect(unmatchedAttributes["http.route"]).toBe("");
    expect(unmatchedAttributes["http.response.status_code"]).toBe(404);
    const dataPoints = await readActivationDurationDataPoints();
    expect(
      dataPoints.map(
        (dataPoint) => decodedAttributes(dataPoint.attributes)["http.route"],
      ),
    ).toEqual(["/api/nested/:key", "/api/v2/deep"]);
    expect(lines).toEqual([]);
  });

  it("produces the SERVER span, mounted route template, and exception event on express 4", async () => {
    prepareFirstRequestActivation();
    const app4 = express4();
    useApitally(app4, { writeToken: WRITE_TOKEN });
    const mountedRouter = express4.Router();
    mountedRouter.get("/things/:id", (_req, res) => {
      res.json({ ok: true });
    });
    app4.use("/mounted", mountedRouter);
    app4.get("/boom", () => {
      throw new Error("bang");
    });
    await withServer(app4, async (_server4, baseUrl) => {
      const okResponse = await fetch(`${baseUrl}/mounted/things/7`);
      expect(okResponse.status).toBe(200);
      await okResponse.arrayBuffer();
      const errorResponse = await fetch(`${baseUrl}/boom`);
      expect(errorResponse.status).toBe(500);
      await errorResponse.arrayBuffer();
    });

    const spans = await readActivationSpans();
    expect(spans.map((span) => [span.name, span.kind])).toEqual([
      ["GET /mounted/things/:id", PROTO_SPAN_KIND_SERVER],
      ["GET /boom", PROTO_SPAN_KIND_SERVER],
    ]);
    expect(spans[1].events).toHaveLength(1);
    const eventAttributes = decodedAttributes(spans[1].events[0].attributes);
    expect(spans[1].events[0].name).toBe("exception");
    expect(eventAttributes["exception.message"]).toBe("bang");
  });

  it("warns when mounting a router with uncaptured registrations and exports its requests with a cleared route skipped by the request metrics", async () => {
    const lines = captureStderr();
    prepareFirstRequestActivation();
    const legacyApp = express();
    useApitally(legacyApp, { writeToken: WRITE_TOKEN });
    legacyApp.use("/legacy", preAssembledRouter);
    await withServer(legacyApp, async (_legacyServer, baseUrl) => {
      const response = await fetch(`${baseUrl}/legacy/pre/1`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET");
    expect(decodedAttributes(spans[0].attributes)["http.route"]).toBe("");
    expect(await readActivationDurationDataPoints()).toEqual([]);
    const registerWarnings = lines.filter((line) =>
      line.includes("apitally/express/register"),
    );
    expect(registerWarnings).toHaveLength(2);
  });

  it("excludes health check requests from spans while counting them in the request metrics, and records OPTIONS requests in neither", async () => {
    // Capture stays enabled so excluded requests provably export no payloads
    prepareFirstRequestActivation({
      captureRequestBody: true,
      captureResponseBody: true,
    });
    await request(server).get("/healthz").expect(200);
    await request(server).options("/items/42").expect(200);

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(decodedAttributes(dataPoints[0].attributes)["http.route"]).toBe(
      "/healthz",
    );
    expect(dataPoints[0].count).toBe(1);
  });

  it("records the exception event on the SERVER span for an unhandled route error and exports a 5xx status", async () => {
    prepareFirstRequestActivation();
    await request(server).get("/error").expect(500);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /error");
    expect(
      decodedAttributes(spans[0].attributes)["http.response.status_code"],
    ).toBe(500);
    expect(spans[0].events).toHaveLength(1);
    expect(spans[0].events[0].name).toBe("exception");
    const eventAttributes = decodedAttributes(spans[0].events[0].attributes);
    expect(eventAttributes["exception.type"]).toBe("Error");
    expect(eventAttributes["exception.message"]).toBe("boom");
    expect(typeof eventAttributes["exception.stacktrace"]).toBe("string");
  });

  it("adopts an active SERVER span from user instrumentation without producing a duplicate and layers capture and metrics on top", async () => {
    const handles = configureAndActivate({ captureResponseBody: true });
    const adoptedApp = buildAppFixture({ captureResponseBody: true });
    const userTracer = trace.getTracer("user-instrumentation");
    const appWithHandle = adoptedApp as unknown as {
      handle: (req: IncomingMessage, res: ServerResponse) => unknown;
    };
    const sdkHandle = appWithHandle.handle;
    appWithHandle.handle = function (
      this: unknown,
      req: IncomingMessage,
      res: ServerResponse,
    ): unknown {
      const method = req.method ?? "GET";
      const span = userTracer.startSpan(method, {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": method,
          "url.path": (req.url ?? "/").split("?")[0],
          "url.scheme": "http",
        },
      });
      res.once("close", () => span.end());
      return context.with(trace.setSpan(context.active(), span), () =>
        sdkHandle.call(this, req, res),
      );
    };
    const released = waitForNextRequestFinish(handles.spanPipeline);
    await withServer(adoptedApp, async (_adoptedServer, baseUrl) => {
      const response = await fetch(`${baseUrl}/items/5`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      await released;
    });

    const traceRequest = await readTraceExportFromSpool(
      handles.spanPipeline,
      handles.spool,
    );
    const spans = decodedSpans(traceRequest);
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe(PROTO_SPAN_KIND_SERVER);
    const scopeNames = traceRequest.resourceSpans.flatMap((resourceSpans) =>
      resourceSpans.scopeSpans.map((scopeSpans) => scopeSpans.scope?.name),
    );
    expect(scopeNames).toEqual(["user-instrumentation"]);
    const attributes = decodedAttributes(spans[0].attributes);
    expect(attributes["http.route"]).toBe("/items/:id");
    expect(attributes["http.response.status_code"]).toBe(200);
    expect(attributes["apitally.response.body"]).toBe(
      JSON.stringify({ id: 5, name: "Widget" }),
    );
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(decodedAttributes(dataPoints[0].attributes)["http.route"]).toBe(
      "/items/:id",
    );
  });

  it("warns once about partial trace coverage when a request arrives under an unsampled span context while metrics keep recording", async () => {
    configureAndActivate();
    const lines = captureStderr();
    const unsampledApp = express();
    useApitally(unsampledApp, { writeToken: WRITE_TOKEN });
    unsampledApp.get("/unsampled", (_req, res) => {
      res.json({ ok: true });
    });
    const appWithHandle = unsampledApp as unknown as {
      handle: (req: IncomingMessage, res: ServerResponse) => unknown;
    };
    const sdkHandle = appWithHandle.handle;
    const unsampledSpan = trace.wrapSpanContext({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.NONE,
    });
    appWithHandle.handle = function (
      this: unknown,
      req: IncomingMessage,
      res: ServerResponse,
    ): unknown {
      return context.with(trace.setSpan(context.active(), unsampledSpan), () =>
        sdkHandle.call(this, req, res),
      );
    };
    await withServer(unsampledApp, async (_unsampledServer, baseUrl) => {
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${baseUrl}/unsampled`);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
    });

    expect(
      lines.filter((line) => line.includes("did not sample")),
    ).toHaveLength(1);
    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].count).toBe(2);
    expect(decodedAttributes(dataPoints[0].attributes)["http.route"]).toBe(
      "/unsampled",
    );
  });

  it("sets HTTP RPC metadata on the request context visible to downstream middleware and writes the route onto it at completion", async () => {
    prepareFirstRequestActivation();
    const rpcApp = express();
    useApitally(rpcApp, { writeToken: WRITE_TOKEN });
    let observedMetadata: RPCMetadata | undefined;
    rpcApp.use((_req, _res, next) => {
      observedMetadata = getRPCMetadata(context.active());
      next();
    });
    rpcApp.get("/things/:id", (_req, res) => {
      res.json({ ok: true });
    });
    await withServer(rpcApp, async (_rpcServer, baseUrl) => {
      const response = await fetch(`${baseUrl}/things/9`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });

    expect(observedMetadata?.type).toBe(RPCType.HTTP);
    expect(observedMetadata?.route).toBe("/things/:id");
  });

  it("captures the request body only when the app consumes it and never reads an unconsumed body", async () => {
    prepareFirstRequestActivation({ captureRequestBody: true });
    const ignoringApp = express();
    useApitally(ignoringApp, {
      writeToken: WRITE_TOKEN,
      captureRequestBody: true,
    });
    ignoringApp.post("/ignore", (_req, res) => {
      res.json({ ok: true });
    });
    await withServer(ignoringApp, async (_ignoringServer, baseUrl) => {
      const response = await fetch(`${baseUrl}/ignore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"unread"}',
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    const attributes = decodedAttributes(spans[0].attributes);
    expect(attributes["apitally.request.body"]).toBeUndefined();
    expect(attributes["http.request.body.size"]).toBe(17);
  });

  it("captures, masks, and redacts request and response bodies per configuration and keeps captured payloads off the live span", async () => {
    let sampledAttributes: Attributes | undefined;
    prepareFirstRequestActivation({
      captureRequestBody: true,
      captureResponseBody: true,
      maskRequestBody: (body) =>
        Buffer.from(body.toString().replace("Widget", "Gadget")),
      sampleOnResponse: (span) => {
        sampledAttributes = { ...span.attributes };
        return true;
      },
    });
    await request(server)
      .post("/items")
      .send({ name: "Widget", password: "hunter2" })
      .expect(201);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    const attributes = decodedAttributes(spans[0].attributes);
    expect(attributes["apitally.request.body"]).toBe(
      JSON.stringify({ name: "Gadget", password: "[REDACTED]" }),
    );
    expect(attributes["apitally.response.body"]).toBe(
      JSON.stringify({
        received: { name: "Widget", password: "[REDACTED]" },
      }),
    );
    expect(sampledAttributes).toBeDefined();
    expect(sampledAttributes?.["http.route"]).toBe("/items");
    expect(sampledAttributes?.["apitally.request.body"]).toBeUndefined();
    expect(sampledAttributes?.["apitally.response.body"]).toBeUndefined();
  });

  it("reports correct sizes and complete body capture for streaming responses", async () => {
    prepareFirstRequestActivation({ captureResponseBody: true });
    const response = await request(server).get("/stream").expect(200);
    expect(response.text).toBe("chunk-1\nchunk-2\nchunk-3\n");

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
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

  it("captures the compressed wire bytes of the response body with matching size attributes when compression middleware is active", async () => {
    prepareFirstRequestActivation({ captureResponseBody: true });
    const compressedApp = express();
    useApitally(compressedApp, {
      writeToken: WRITE_TOKEN,
      captureResponseBody: true,
    });
    compressedApp.use(compression({ threshold: 0 }));
    const payload = { data: "x".repeat(2048) };
    compressedApp.get("/compressed", (_req, res) => {
      res.json(payload);
    });
    await withServer(compressedApp, async (_compressedServer, baseUrl) => {
      const response = await fetch(`${baseUrl}/compressed`, {
        headers: { "accept-encoding": "gzip" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(await response.json()).toEqual(payload);
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    const attributes = decodedAttributes(spans[0].attributes);
    const capturedBody = attributes["apitally.response.body"];
    expect(capturedBody).toBeInstanceOf(Uint8Array);
    const capturedBytes = Buffer.from(capturedBody as Uint8Array);
    expect(gunzipSync(capturedBytes).toString()).toBe(JSON.stringify(payload));
    expect(attributes["http.response.body.size"]).toBe(capturedBytes.length);
  });

  it("propagates a consumer set in a handler to the metrics dimensions", async () => {
    prepareFirstRequestActivation();
    await request(server).get("/consumer").expect(200);

    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(decodedAttributes(dataPoints[0].attributes)).toEqual({
      "http.request.method": "GET",
      "http.route": "/consumer",
      "http.response.status_code": 200,
      "apitally.consumer.identifier": "acme",
      "url.scheme": "http",
    });
  });

  it("activates on the first request and stays idempotent across repeated useApitally calls", async () => {
    prepareFirstRequestActivation();
    expect(isActivated()).toBe(false);
    useApitally(app, { writeToken: WRITE_TOKEN });
    await request(server).get("/items/1").expect(200);
    expect(isActivated()).toBe(true);
    await request(server).get("/items/2").expect(200);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(2);
  });

  it("drops spans while keeping metrics with a zero sample rate", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    await request(server).get("/items/3").expect(200);

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(decodedAttributes(dataPoints[0].attributes)["http.route"]).toBe(
      "/items/:id",
    );
  });

  it("flushes buffered telemetry when the server closes", async () => {
    const stub = await StubOtlpServer.start();
    try {
      process.env.APITALLY_OTLP_ENDPOINT = stub.url;
      prepareFirstRequestActivation();
      await request(server).get("/items/6").expect(200);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await stub.waitForRequests(2);
      expect(stub.paths().sort()).toEqual(["/v1/metrics", "/v1/traces"]);
    } finally {
      await stub.close();
    }
  });

  it("keeps exporting requests served by a second server after the first one closes", async () => {
    prepareFirstRequestActivation();
    const serverA = createServer(app);
    const serverB = createServer(app);
    await new Promise<void>((resolve) => {
      serverA.listen(0, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => {
      serverB.listen(0, "127.0.0.1", resolve);
    });
    try {
      await request(serverA).get("/items/1").expect(200);
      await request(serverB).get("/items/2").expect(200);
      await new Promise<void>((resolve) => {
        serverA.close(() => resolve());
      });
      // The close-triggered flush cycle completes before the next request
      await requireActivationHandles().worker.runCycle();
      await request(serverB).get("/items/3").expect(200);

      const spans = await readActivationSpans();
      expect(spans.map((span) => span.name)).toEqual([
        "GET /items/:id",
        "GET /items/:id",
        "GET /items/:id",
      ]);
    } finally {
      await new Promise<void>((resolve) => {
        serverB.close(() => resolve());
      });
    }
  });

  it("serves and exports a request dispatched without a live socket server", async () => {
    prepareFirstRequestActivation();
    const connection = new PassThrough();
    const req = new IncomingMessage(connection as unknown as Socket);
    req.method = "GET";
    req.url = "/items/8";
    req.headers = { host: "localhost" };
    const res = new ServerResponse(req);
    res.assignSocket(connection as unknown as Socket);
    const finished = once(res, "finish");
    (
      app as unknown as {
        handle: (req: IncomingMessage, res: ServerResponse) => void;
      }
    ).handle(req, res);
    await finished;
    expect(res.statusCode).toBe(200);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
  });

  it("delivers spans, logs, and metrics through the full production assembly to the OTLP endpoint", async () => {
    const stub = await StubOtlpServer.start();
    try {
      process.env.APITALLY_OTLP_ENDPOINT = stub.url;
      prepareFirstRequestActivation();
      const smokeApp = buildAppFixture();
      await withServer(smokeApp, async (_smokeServer, baseUrl) => {
        const response = await fetch(`${baseUrl}/items/11`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: 11, name: "Widget" });
        await requireActivationHandles().worker.runCycle();
        await stub.waitForRequests(3);

        const spans = decodedSpans(
          decodeTraceExport(stub.bodyFor("/v1/traces")),
        );
        expect(spans).toHaveLength(1);
        expect(spans[0].name).toBe("GET /items/:id");
        expect(spans[0].kind).toBe(PROTO_SPAN_KIND_SERVER);

        const logRecords = decodedLogRecords(
          decodeLogsExport(stub.bodyFor("/v1/logs")),
        );
        expect(logRecords).toHaveLength(1);
        expect(logRecords[0].eventName).toBe("apitally.app.startup");
        const startupPayload = JSON.parse(
          logRecords[0].body?.stringValue ?? "",
        ) as {
          framework: string;
          versions: Record<string, string>;
          paths: { method: string; path: string }[];
        };
        expect(startupPayload.framework).toBe("express");
        expect(startupPayload.versions.node).toBe(process.versions.node);
        expect(startupPayload.paths).toEqual([
          { method: "GET", path: "/items/:id" },
          { method: "POST", path: "/items" },
          { method: "GET", path: "/healthz" },
          { method: "GET", path: "/error" },
          { method: "GET", path: "/consumer" },
          { method: "GET", path: "/stream" },
          { method: "GET", path: "/api/nested/:key" },
          { method: "GET", path: "/api/v2/deep" },
        ]);

        const metrics = decodedMetrics(
          decodeMetricsExport(stub.bodyFor("/v1/metrics")),
        );
        const dataPoints = durationDataPoints(metrics);
        expect(dataPoints).toHaveLength(1);
        expect(dataPoints[0].count).toBe(1);
        expect(decodedAttributes(dataPoints[0].attributes)).toEqual({
          "http.request.method": "GET",
          "http.route": "/items/:id",
          "http.response.status_code": 200,
          "url.scheme": "http",
        });
        expect(metrics.map((metric) => metric.name).sort()).toEqual([
          "http.server.request.duration",
          "http.server.response.body.size",
          "process.cpu.utilization",
          "process.memory.usage",
          "process.uptime",
        ]);
      });
    } finally {
      await stub.close();
    }
  });
});
