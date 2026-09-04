import {
  server as createServer,
  type Server,
  type ServerInjectOptions,
  type ServerInjectResponse,
} from "@hapi/hapi";
import type { Attributes } from "@opentelemetry/api";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isActivated } from "../../src/activation.js";
import { apitallyPlugin, useApitally } from "../../src/hapi/index.js";
import { drainServerErrors } from "../../src/serverErrors.js";
import { span } from "../../src/tracing.js";
import {
  configureAndActivate,
  prepareFirstRequestActivation,
  readActivationDurationDataPoints,
  readActivationSpans,
  readFetchPaths,
  readSerializedLogRecords,
  readSerializedSpans,
  requireActivationHandles,
  spyOnHeldFirstFetch,
  WRITE_TOKEN,
} from "../utils.js";
import { buildAppFixture } from "./app.js";

async function inject(
  server: Server,
  options: string | ServerInjectOptions,
): Promise<ServerInjectResponse> {
  const response = await server.inject(options);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  return response;
}

describe("hapi integration", () => {
  let server: Server;

  beforeAll(async () => {
    prepareFirstRequestActivation();
    server = await buildAppFixture();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("exports one SERVER span per request with stable semconv attributes and the {method} {route} span name", async () => {
    prepareFirstRequestActivation();
    const response = await inject(server, {
      method: "GET",
      url: "/items/42?color=blue",
      headers: { host: "localhost", "user-agent": "test-client" },
    });
    expect(response.statusCode).toBe(200);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/{id}");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    const attributes = spans[0].attributes;
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
      "url.full": "http://localhost/items/42?color=blue",
      "server.address": "localhost",
      "client.address": "127.0.0.1",
      "user_agent.original": "test-client",
      "http.route": "/items/{id}",
      "http.response.status_code": 200,
      "http.response.body.size": Buffer.byteLength(JSON.stringify({ id: 42, name: "Widget" })),
    });
  });

  it("continues the remote trace from a traceparent header and exports the request even when the upstream trace is unsampled", async () => {
    prepareFirstRequestActivation();
    const sampledTraceId = "0af7651916cd43dd8448eb211c80319c";
    const unsampledTraceId = "1bf7651916cd43dd8448eb211c80319d";
    const parentSpanId = "b7ad6b7169203331";
    await inject(server, {
      method: "GET",
      url: "/items/1",
      headers: { traceparent: `00-${sampledTraceId}-${parentSpanId}-01` },
    });
    await inject(server, {
      method: "GET",
      url: "/items/2",
      headers: { traceparent: `00-${unsampledTraceId}-${parentSpanId}-00` },
    });

    const spans = await readActivationSpans();
    expect(spans.map((requestSpan) => requestSpan.spanContext().traceId)).toEqual([
      sampledTraceId,
      unsampledTraceId,
    ]);
    for (const requestSpan of spans) {
      expect(requestSpan.parentSpanContext?.spanId).toBe(parentSpanId);
    }
  });

  it("includes mount prefixes in route templates for nested routers and exports unmatched requests with a cleared route skipped by the request metrics", async () => {
    prepareFirstRequestActivation();
    await inject(server, "/api/nested/abc");
    await inject(server, "/api/v2/deep");
    const response = await inject(server, "/nope");
    expect(response.statusCode).toBe(404);

    const spans = await readActivationSpans();
    expect(spans.map((requestSpan) => requestSpan.name)).toEqual([
      "GET /api/nested/{key}",
      "GET /api/v2/deep",
      "GET",
    ]);
    expect(spans[2].attributes["http.route"]).toBe("");
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints.map((dataPoint) => dataPoint.attributes["http.route"])).toEqual([
      "/api/nested/{key}",
      "/api/v2/deep",
    ]);
  });

  it("excludes health check requests from spans while counting them in the request metrics, and records OPTIONS and WebSocket upgrade requests in neither", async () => {
    prepareFirstRequestActivation({ captureRequestBody: true, captureResponseBody: true });
    await inject(server, "/healthz");
    await inject(server, { method: "OPTIONS", url: "/items/42" });
    await inject(server, {
      method: "GET",
      url: "/items/42",
      headers: { upgrade: "WebSocket" },
    });

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/healthz");
  });

  it("records an exception for an unhandled 5xx error while treating a Hapi validation 4xx as ordinary response telemetry", async () => {
    prepareFirstRequestActivation();
    const validationResponse = await inject(server, "/validated");
    expect(validationResponse.statusCode).toBe(400);
    const errorResponse = await inject(server, "/error");
    expect(errorResponse.statusCode).toBe(500);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(2);
    expect(spans[0].name).toBe("GET /validated");
    expect(spans[0].events).toEqual([]);
    expect(spans[1].name).toBe("GET /error");
    expect(spans[1].events).toHaveLength(1);
    expect(spans[1].events[0].name).toBe("exception");
    expect(spans[1].events[0].attributes?.["exception.message"]).toBe("boom");
  });

  it("counts server errors independently of trace sampling", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    const errorResponse = await inject(server, "/error");
    expect(errorResponse.statusCode).toBe(500);

    expect(await readActivationSpans()).toEqual([]);
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

  it("adopts an active SERVER span from user instrumentation without producing a duplicate and layers capture and metrics on top", async () => {
    const handles = configureAndActivate({ captureResponseBody: true });
    const adoptedServer = await buildAppFixture({ captureResponseBody: true });
    const userSpan = trace.getTracer("user-instrumentation").startSpan("GET", {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": "GET",
        "url.path": "/items/5",
        "url.scheme": "http",
      },
    });
    const response = await context.with(trace.setSpan(context.active(), userSpan), () =>
      inject(adoptedServer, "/items/5"),
    );
    expect(response.statusCode).toBe(200);
    userSpan.end();
    await adoptedServer.stop();

    await handles.spanPipeline.forceFlush();
    const spans = readSerializedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].instrumentationScope?.name).toBe("user-instrumentation");
    expect(spans[0].attributes["http.route"]).toBe("/items/{id}");
    expect(spans[0].attributes["apitally.response.body"]).toBe(
      JSON.stringify({ id: 5, name: "Widget" }),
    );
    expect(await readActivationDurationDataPoints()).toHaveLength(1);
  });

  it("captures, masks, and redacts request and response bodies per configuration and keeps captured payloads off the live span", async () => {
    let sampledAttributes: Attributes | undefined;
    prepareFirstRequestActivation({
      captureRequestBody: true,
      captureResponseBody: true,
      maskRequestBody: (body) => Buffer.from(body.toString().replace("Widget", "Gadget")),
      sampleOnResponse: (requestSpan) => {
        sampledAttributes = { ...requestSpan.attributes };
        return true;
      },
    });
    const wireBody = '{ "name": "Widget", "password": "hunter2" }';
    const response = await inject(server, {
      method: "POST",
      url: "/items",
      headers: { "content-type": "application/json" },
      payload: wireBody,
    });
    expect(response.statusCode).toBe(201);

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
    const response = await inject(server, "/stream");
    expect(response.payload).toBe("chunk-1\nchunk-2\nchunk-3\n");

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["http.response.body.size"]).toBe(24);
    expect(spans[0].attributes["apitally.response.body"]).toBe("chunk-1\nchunk-2\nchunk-3\n");
  });

  it("propagates a consumer set in a handler to the metrics dimensions", async () => {
    prepareFirstRequestActivation();
    await inject(server, "/consumer");

    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["apitally.consumer.identifier"]).toBe("acme");
  });

  it("activates on the first injected request and stays idempotent across repeated useApitally calls", async () => {
    prepareFirstRequestActivation();
    expect(isActivated()).toBe(false);
    useApitally(server, { writeToken: WRITE_TOKEN });
    await inject(server, "/items/1");
    expect(isActivated()).toBe(true);
    useApitally(server, { writeToken: WRITE_TOKEN });
    await inject(server, "/items/2");
    expect(await readActivationSpans()).toHaveLength(2);
  });

  it("drops spans while keeping metrics with a zero sample rate", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    await inject(server, "/items/3");

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/items/{id}");
  });

  it("keeps a child span created by a route handler under the request SERVER span", async () => {
    prepareFirstRequestActivation();
    const contextServer = createServer();
    await contextServer.register(apitallyPlugin({ writeToken: WRITE_TOKEN }));
    contextServer.route({
      method: "GET",
      path: "/child",
      handler: () => span("child", () => ({ ok: true })),
    });
    await inject(contextServer, "/child");
    await contextServer.stop();

    const spans = await readActivationSpans();
    expect(spans.map((requestSpan) => requestSpan.name)).toEqual(["child", "GET /child"]);
    expect(spans[0].parentSpanContext?.spanId).toBe(spans[1].spanContext().spanId);
  });

  it("activates during server.initialize() and emits complete prefixed startup routes from server.table()", async () => {
    prepareFirstRequestActivation();
    const startupServer = createServer();
    await startupServer.register(apitallyPlugin({ writeToken: WRITE_TOKEN }));
    await startupServer.register(
      {
        name: "startup-api",
        register: (api) => {
          api.route({ method: "GET", path: "/items/{id}", handler: () => ({ ok: true }) });
        },
      },
      { routes: { prefix: "/api" } },
    );
    startupServer.route({ method: "*", path: "/fallback", handler: () => ({ ok: true }) });
    await startupServer.initialize();
    expect(isActivated()).toBe(true);

    const handles = requireActivationHandles();
    await handles.loggerProvider.forceFlush();
    const startupRecord = readSerializedLogRecords().find(
      (record) => record.eventName === "apitally.app.startup",
    );
    const payload = JSON.parse(String(startupRecord?.body)) as {
      framework: string;
      paths: { method: string; path: string }[];
    };
    expect(payload.framework).toBe("hapi");
    expect(payload.paths).toEqual([{ method: "GET", path: "/api/items/{id}" }]);
    await startupServer.stop();
  });

  it("flushes buffered traces, logs, and metrics when server.stop() reaches onPostStop", async () => {
    prepareFirstRequestActivation();
    const stoppingServer = createServer({ port: 0, host: "127.0.0.1" });
    await stoppingServer.register(apitallyPlugin({ writeToken: WRITE_TOKEN }));
    stoppingServer.route({
      method: "GET",
      path: "/items",
      handler: (request) => {
        request.log("info", "stopping");
        return { ok: true };
      },
    });
    await stoppingServer.start();
    await inject(stoppingServer, "/items");
    const { fetchSpy, firstFetchObserved, releaseFirstFetch } = spyOnHeldFirstFetch();

    const stopPromise = stoppingServer.stop();
    await firstFetchObserved;
    releaseFirstFetch();
    await stopPromise;
    expect(readFetchPaths(fetchSpy).sort()).toEqual(["/v1/logs", "/v1/metrics", "/v1/traces"]);
  });

  it("captures native request.log() application events from onPostResponse", async () => {
    prepareFirstRequestActivation();
    const postResponseServer = createServer();
    await postResponseServer.register(apitallyPlugin({ writeToken: WRITE_TOKEN }));
    postResponseServer.ext("onPostResponse", (request, h) => {
      request.log("info", "post response");
      return h.continue;
    });
    postResponseServer.route({
      method: "GET",
      path: "/items",
      handler: () => ({ ok: true }),
    });

    await inject(postResponseServer, "/items");
    const spans = await readActivationSpans();
    const handles = requireActivationHandles();
    await handles.loggerProvider.forceFlush();
    const records = readSerializedLogRecords().filter(
      (record) => record.instrumentationScope.name === "hapi",
    );
    expect(records).toHaveLength(1);
    expect(records[0].body).toBe("post response");
    expect(records[0].attributes["apitally.request.server_span_id"]).toBe(
      spans[0].spanContext().spanId,
    );
    await postResponseServer.stop();
  });

  it("captures native request.log() application events with severity and request linkage", async () => {
    prepareFirstRequestActivation();
    await inject(server, "/logs");
    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    const handles = requireActivationHandles();
    await handles.loggerProvider.forceFlush();

    const records = readSerializedLogRecords().filter(
      (record) => record.instrumentationScope.name === "hapi",
    );
    expect(records).toHaveLength(2);
    expect(String(records[0].body)).toContain("Error: native failure");
    expect(records[0].severityNumber).toBe(SeverityNumber.ERROR);
    expect(records[0].severityText).toBe("error");
    expect(records[1].body).toBe("plain message");
    expect(records[1].severityNumber).toBe(SeverityNumber.INFO);
    expect(records[1].severityText).toBe("log");
    const serverSpanId = spans[0].spanContext().spanId;
    expect(records.map((record) => record.attributes["apitally.request.server_span_id"])).toEqual([
      serverSpanId,
      serverSpanId,
    ]);
  });
});
