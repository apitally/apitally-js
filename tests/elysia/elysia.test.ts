import { type Attributes, context, SpanKind, trace } from "@opentelemetry/api";
import { type AnyElysia, Elysia } from "elysia";
import { beforeAll, describe, expect, it } from "vitest";
import { isActivated } from "../../src/activation.js";
import { apitallyPlugin, useApitally } from "../../src/elysia/index.js";
import {
  captureStderr,
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
} from "../utils.js";
import { buildAppFixture } from "./app.js";

describe("elysia integration", () => {
  let app: AnyElysia;

  beforeAll(() => {
    prepareFirstRequestActivation();
    app = buildAppFixture();
  });

  it("exports one SERVER span per request with stable semconv attributes and the {method} {route} span name", async () => {
    prepareFirstRequestActivation();
    const response = await request(app, "/items/42?color=blue");
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    const attributes = spans[0].attributes;
    expect(attributes["http.response.header.content-type"]).toEqual([
      expect.stringContaining("application/json"),
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
      const response = await request(app, "/items/1", {
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
      const response = await request(app, path);
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
    const healthResponse = await request(app, "/healthz");
    await readResponseAndSettleTransport(healthResponse);
    const optionsResponse = await request(app, "/items/42", { method: "OPTIONS" });
    await readResponseAndSettleTransport(optionsResponse);

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/healthz");
  });

  it("records an exception for an unhandled 5xx while treating expected 4xx errors as response telemetry", async () => {
    prepareFirstRequestActivation();
    const badRequestResponse = await request(app, "/bad-request");
    expect(badRequestResponse.status).toBe(400);
    await readResponseAndSettleTransport(badRequestResponse);
    const errorResponse = await request(app, "/error");
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

  it("adopts an active user SERVER span without producing a duplicate and layers capture and metrics on top", async () => {
    const handles = configureAndActivate({ captureResponseBody: true });
    const adoptedApp = buildAppFixture({ captureResponseBody: true });
    const userTracer = trace.getTracer("user-instrumentation");
    const originalHandle = adoptedApp.handle;
    adoptedApp.handle = (request) => {
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
        const response = await originalHandle.call(adoptedApp, request);
        span.end();
        return response;
      });
    };
    const released = waitForNextRequestFinish(handles.spanPipeline);
    const response = await request(adoptedApp, "/items/5");
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

  it("captures, masks, and redacts request and response bodies while keeping payloads off the live span", async () => {
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
    const response = await request(app, "/items", {
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

  it("reports correct sizes and complete body capture for a streamed response", async () => {
    prepareFirstRequestActivation({ captureResponseBody: true });
    const response = await request(app, "/stream");
    const body = await readResponseAndSettleTransport(response);
    expect(body.toString()).toBe("chunk-1\nchunk-2\nchunk-3\n");

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["http.response.body.size"]).toBe(24);
    expect(spans[0].attributes["apitally.response.body"]).toBe("chunk-1\nchunk-2\nchunk-3\n");
  });

  it("propagates a consumer set in a handler to the metrics dimensions", async () => {
    prepareFirstRequestActivation();
    const response = await request(app, "/consumer");
    await readResponseAndSettleTransport(response);

    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["apitally.consumer.identifier"]).toBe("acme");
  });

  it("activates on the first request and stays idempotent across both setup APIs", async () => {
    prepareFirstRequestActivation();
    const directApp = new Elysia();
    useApitally(directApp, { writeToken: WRITE_TOKEN });
    useApitally(directApp, { writeToken: WRITE_TOKEN });
    directApp.get("/direct/:id", ({ params }) => ({ id: params.id }));
    const pluginApp = new Elysia()
      .use(apitallyPlugin({ writeToken: WRITE_TOKEN }))
      .use(apitallyPlugin({ writeToken: WRITE_TOKEN }))
      .get("/plugin/:id", ({ params }) => ({ id: params.id }));
    expect(isActivated()).toBe(false);

    for (const [targetApp, path] of [
      [directApp, "/direct/1"],
      [pluginApp, "/plugin/2"],
    ] as const) {
      const response = await request(targetApp, path);
      expect(response.status).toBe(200);
      await readResponseAndSettleTransport(response);
    }
    expect(isActivated()).toBe(true);

    const spans = await readActivationSpans();
    expect(spans.map((span) => span.name)).toEqual(["GET /direct/:id", "GET /plugin/:id"]);
    const handles = requireActivationHandles();
    await handles.loggerProvider.forceFlush();
    const startupRecords = readSerializedLogRecords().filter(
      (record) => record.eventName === "apitally.app.startup",
    );
    expect(startupRecords).toHaveLength(1);
    const startup = JSON.parse(String(startupRecords[0].body)) as {
      framework: string;
      versions: Record<string, string>;
      paths: { method: string; path: string }[];
    };
    expect(startup.framework).toBe("elysia");
    expect(startup.versions.elysia).toMatch(/^1\./);
    expect(startup.paths).toEqual([{ method: "GET", path: "/direct/:id" }]);
  });

  it("drops spans while retaining metrics with sampleRate zero", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    const response = await request(app, "/items/3");
    await readResponseAndSettleTransport(response);

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("warns once and leaves existing routes unchanged when direct setup follows route registration", async () => {
    const lines = captureStderr();
    prepareFirstRequestActivation();
    const lateApp = new Elysia().get("/early/:id", ({ params }) => ({ id: params.id }));
    useApitally(lateApp, { writeToken: WRITE_TOKEN });
    useApitally(lateApp, { writeToken: WRITE_TOKEN });

    const response = await request(lateApp, "/early/1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "1" });
    expect(isActivated()).toBe(false);
    expect(lines.filter((line) => line.includes("before registering routes"))).toHaveLength(1);
  });
});

function request(app: AnyElysia, path: string, init?: RequestInit): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, init));
}
