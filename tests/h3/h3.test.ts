import { type Attributes, context, SpanKind, trace } from "@opentelemetry/api";
import { defineWebSocketHandler, H3, noContent, toNodeListener } from "h3";
import { beforeAll, describe, expect, it } from "vitest";
import { isActivated } from "../../src/activation.js";
import { apitallyPlugin, useApitally } from "../../src/h3/index.js";
import { setConsumer, setRequestAttribute } from "../../src/index.js";
import { drainServerErrors } from "../../src/serverErrors.js";
import { drainValidationErrors } from "../../src/validationErrors.js";
import {
  configureAndActivate,
  prepareFirstRequestActivation,
  readActivationDurationDataPoints,
  readActivationSpans,
  readResponseAndSettleTransport,
  readSerializedLogRecords,
  readSerializedSpans,
  requireActivationHandles,
  WRITE_TOKEN,
  waitForNextRequestFinish,
  withServer,
} from "../utils.js";
import { buildAppFixture } from "./app.js";

describe("h3 integration", () => {
  let app: H3;

  beforeAll(() => {
    prepareFirstRequestActivation();
    app = buildAppFixture();
  });

  it("exports one SERVER span per request with stable semconv attributes and the {method} {route} span name", async () => {
    prepareFirstRequestActivation();
    const response = await app.request("/items/42?color=blue", undefined, {
      clientAddress: "203.0.113.10",
    });
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    const attributes = spans[0].attributes;
    expect(attributes["http.response.header.content-type"]).toEqual([
      "application/json;charset=UTF-8",
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
      "url.full": "http://localhost/items/42?color=blue",
      "server.address": "localhost",
      "client.address": "203.0.113.10",
      "http.route": "/items/:id",
      "http.response.status_code": 200,
      "http.response.body.size": Buffer.byteLength(JSON.stringify({ id: 42, name: "Widget" })),
    });
  });

  it("continues the remote trace from a traceparent header and exports the request even when the upstream trace is unsampled", async () => {
    prepareFirstRequestActivation();
    const sampledTraceId = "0af7651916cd43dd8448eb211c80319c";
    const unsampledTraceId = "1bf7651916cd43dd8448eb211c80319d";
    const parentSpanId = "b7ad6b7169203331";
    for (const [traceId, flags] of [
      [sampledTraceId, "01"],
      [unsampledTraceId, "00"],
    ]) {
      const response = await app.request("/items/1", {
        headers: { traceparent: `00-${traceId}-${parentSpanId}-${flags}` },
      });
      expect(response.status).toBe(200);
      await readResponseAndSettleTransport(response);
    }

    const spans = await readActivationSpans();
    expect(spans.map((span) => span.spanContext().traceId)).toEqual([
      sampledTraceId,
      unsampledTraceId,
    ]);
    for (const span of spans) {
      expect(span.parentSpanContext?.spanId).toBe(parentSpanId);
    }
  });

  it("includes mount prefixes in route templates for nested routers and exports unmatched requests with a cleared route skipped by the request metrics", async () => {
    prepareFirstRequestActivation();
    for (const path of ["/api/nested/abc", "/api/v2/deep", "/nope"]) {
      const response = await app.request(path);
      await readResponseAndSettleTransport(response);
    }

    const spans = await readActivationSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "GET /api/nested/:key",
      "GET /api/v2/deep",
      "GET",
    ]);
    expect(spans[2].attributes["http.route"]).toBe("");
    expect(spans[2].attributes["http.response.status_code"]).toBe(404);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints.map((dataPoint) => dataPoint.attributes["http.route"])).toEqual([
      "/api/nested/:key",
      "/api/v2/deep",
    ]);
  });

  it("excludes health check requests from spans while counting them in the request metrics, and records OPTIONS requests in neither", async () => {
    prepareFirstRequestActivation({
      captureRequestBody: true,
      captureResponseBody: true,
    });
    const healthResponse = await app.request("/healthz");
    await readResponseAndSettleTransport(healthResponse);
    const optionsResponse = await app.request("/items/42", { method: "OPTIONS" });
    await readResponseAndSettleTransport(optionsResponse);

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/healthz");
  });

  it("activates but exports no request telemetry for WebSocket upgrades", async () => {
    prepareFirstRequestActivation();
    const websocketApp = new H3({
      plugins: [apitallyPlugin({ writeToken: WRITE_TOKEN })],
    });
    websocketApp.get("/socket", defineWebSocketHandler({}));
    expect(isActivated()).toBe(false);

    const response = await websocketApp.request("/socket", {
      headers: { upgrade: "WebSocket" },
    });
    expect(response.status).toBe(426);
    expect((response as Response & { crossws?: unknown }).crossws).toBeDefined();
    await response.text();
    expect(isActivated()).toBe(true);
    expect(await readActivationSpans()).toEqual([]);
    expect(await readActivationDurationDataPoints()).toEqual([]);
  });

  it("records an exception for an unhandled 5xx error while treating an expected 4xx error as response telemetry", async () => {
    prepareFirstRequestActivation();
    const badRequestResponse = await app.request("/bad-request");
    expect(badRequestResponse.status).toBe(400);
    await readResponseAndSettleTransport(badRequestResponse);
    const errorResponse = await app.request("/error");
    expect(errorResponse.status).toBe(500);
    await readResponseAndSettleTransport(errorResponse);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(2);
    expect(spans[0].name).toBe("GET /bad-request");
    expect(spans[0].events).toEqual([]);
    expect(spans[1].name).toBe("GET /error");
    expect(spans[1].events).toHaveLength(1);
    expect(spans[1].events[0].name).toBe("exception");
    expect(spans[1].events[0].attributes?.["exception.message"]).toBe("boom");
  });

  it("counts validation and server errors independently of trace sampling", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    const validationResponse = await app.request("/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(validationResponse.status).toBe(400);
    await readResponseAndSettleTransport(validationResponse);
    const errorResponse = await app.request("/error");
    expect(errorResponse.status).toBe(500);
    await readResponseAndSettleTransport(errorResponse);

    expect(await readActivationSpans()).toEqual([]);
    expect(drainValidationErrors()).toEqual([
      {
        method: "POST",
        path: "/validate",
        source: "",
        field: "name",
        message: "Required",
        type: "",
        count: 1,
      },
    ]);
    expect(drainServerErrors()).toEqual([
      {
        method: "GET",
        path: "/error",
        type: "Error",
        message: "boom",
        stacktrace: expect.stringContaining("Error: boom"),
        count: 1,
      },
    ]);
  });

  it("keeps H3 request and response hooks inside the request observation", async () => {
    prepareFirstRequestActivation();
    const hookApp = new H3({
      plugins: [apitallyPlugin({ writeToken: WRITE_TOKEN })],
      onRequest: (event) => {
        if (event.url.pathname === "/hook-error") {
          throw new Error("hook boom");
        }
        setConsumer("hook-consumer");
      },
      onResponse: () => {
        setRequestAttribute("h3.response-hook", true);
      },
      onError: (error) =>
        new Response(JSON.stringify({ error: error.message }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      silent: true,
    });
    hookApp.get("/ok", () => ({ ok: true }));
    hookApp.get("/hook-error", () => ({ unreachable: true }));

    const okResponse = await hookApp.request("/ok");
    await readResponseAndSettleTransport(okResponse);
    const errorResponse = await hookApp.request("/hook-error");
    expect(errorResponse.status).toBe(503);
    await readResponseAndSettleTransport(errorResponse);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(2);
    expect(spans[0].attributes["h3.response-hook"]).toBe(true);
    expect(spans[1].events).toHaveLength(1);
    expect(spans[1].events[0].attributes?.["exception.message"]).toBe("hook boom");
    expect(spans[1].attributes["h3.response-hook"]).toBe(true);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["apitally.consumer.identifier"]).toBe("hook-consumer");
  });

  it("adopts an active SERVER span from user instrumentation without producing a duplicate and layers capture and metrics on top", async () => {
    const handles = configureAndActivate({ captureResponseBody: true });
    const adoptedApp = buildAppFixture({ captureResponseBody: true });
    const userTracer = trace.getTracer("user-instrumentation");
    const sdkFetch = adoptedApp.fetch;
    adoptedApp.fetch = (request): Response | Promise<Response> => {
      const url = new URL(request.url);
      const span = userTracer.startSpan(request.method, {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": request.method,
          "url.path": url.pathname,
          "url.scheme": "http",
        },
      });
      return context.with(trace.setSpan(context.active(), span), async () => {
        const response = await sdkFetch(request);
        span.end();
        return response;
      });
    };
    const released = waitForNextRequestFinish(handles.spanPipeline);
    const response = await adoptedApp.fetch(new Request("http://localhost/items/5"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 5, name: "Widget" });
    await released;

    await handles.spanPipeline.forceFlush();
    const spans = readSerializedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].instrumentationScope?.name).toBe("user-instrumentation");
    expect(spans[0].attributes["http.route"]).toBe("/items/:id");
    expect(spans[0].attributes["http.response.status_code"]).toBe(200);
    expect(spans[0].attributes["apitally.response.body"]).toBe(
      JSON.stringify({ id: 5, name: "Widget" }),
    );
  });

  it("captures, masks, and redacts request and response bodies per configuration and keeps captured payloads off the live span", async () => {
    let sampledAttributes: Attributes | undefined;
    prepareFirstRequestActivation({
      captureRequestBody: true,
      captureResponseBody: true,
      maskRequestBody: (body) => Buffer.from(body.toString().replace("Widget", "Gadget")),
      sampleOnResponse: (span) => {
        sampledAttributes = { ...span.attributes };
        return true;
      },
    });
    const wireBody = '{ "name": "Widget", "password": "hunter2" }';
    const response = await app.request("/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: wireBody,
    });
    expect(response.status).toBe(201);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["apitally.request.body"]).toBe(
      JSON.stringify({ name: "Gadget", password: "[REDACTED]" }),
    );
    expect(spans[0].attributes["apitally.response.body"]).toBe(
      JSON.stringify({ received: { name: "Widget", password: "[REDACTED]" } }),
    );
    expect(spans[0].attributes["http.request.body.size"]).toBe(Buffer.byteLength(wireBody));
    expect(sampledAttributes?.["apitally.request.body"]).toBeUndefined();
    expect(sampledAttributes?.["apitally.response.body"]).toBeUndefined();
  });

  it("reports correct sizes and complete body capture for streaming responses", async () => {
    prepareFirstRequestActivation({ captureResponseBody: true });
    const response = await app.request("/stream");
    const body = await readResponseAndSettleTransport(response);
    expect(body.toString()).toBe("chunk-1\nchunk-2\nchunk-3\n");

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["http.response.body.size"]).toBe(24);
    expect(spans[0].attributes["apitally.response.body"]).toBe("chunk-1\nchunk-2\nchunk-3\n");
  });

  it("propagates a consumer set in a handler to the metrics dimensions", async () => {
    prepareFirstRequestActivation();
    const response = await app.request("/consumer");
    await readResponseAndSettleTransport(response);

    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["apitally.consumer.identifier"]).toBe("acme");
  });

  it("activates on the first request and stays idempotent across both setup APIs and internal app fetches", async () => {
    prepareFirstRequestActivation();
    const idempotentApp = new H3({
      plugins: [apitallyPlugin({ writeToken: WRITE_TOKEN })],
    });
    useApitally(idempotentApp, { writeToken: WRITE_TOKEN });
    idempotentApp.get("/target", () => ({ ok: true }));
    idempotentApp.get("/proxy", (event) =>
      event.app?.fetch(new Request("http://localhost/target")),
    );
    expect(isActivated()).toBe(false);

    const response = await idempotentApp.request("/proxy");
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);
    expect(isActivated()).toBe(true);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /proxy");
    const handles = requireActivationHandles();
    await handles.loggerProvider.forceFlush();
    const startupRecords = readSerializedLogRecords().filter(
      (record) => record.eventName === "apitally.app.startup",
    );
    expect(startupRecords).toHaveLength(1);
    const startup = JSON.parse(String(startupRecords[0].body)) as {
      framework: string;
      versions: Record<string, string>;
    };
    expect(startup.framework).toBe("h3");
    expect(startup.versions.h3).toMatch(/^2\./);
  });

  it("exports the final status for a bodiless response through the Node adapter", async () => {
    prepareFirstRequestActivation();
    const nodeApp = new H3({
      plugins: [apitallyPlugin({ writeToken: WRITE_TOKEN })],
    });
    nodeApp.delete("/items/:id", () => noContent());

    await withServer(toNodeListener(nodeApp), async (_server, baseUrl) => {
      const response = await fetch(`${baseUrl}/items/1`, { method: "DELETE" });
      expect(response.status).toBe(204);
      await readResponseAndSettleTransport(response);
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["http.response.status_code"]).toBe(204);
  });

  it("drops spans while keeping metrics with a zero sample rate", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    const response = await app.request("/items/3");
    await readResponseAndSettleTransport(response);

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/items/:id");
  });
});
