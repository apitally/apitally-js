import { type Attributes, context, SpanKind, trace } from "@opentelemetry/api";
import { type FastifyInstance, fastify } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isActivated } from "../../src/activation.js";
import { useApitally } from "../../src/fastify/index.js";
import { drainServerErrors } from "../../src/serverErrors.js";
import { span } from "../../src/tracing.js";
import { drainValidationErrors } from "../../src/validationErrors.js";
import {
  captureStderr,
  configureAndActivate,
  prepareFirstRequestActivation,
  readActivationDurationDataPoints,
  readActivationSpans,
  readFetchPaths,
  readResponseAndSettleTransport,
  readSerializedLogRecords,
  readSerializedSpans,
  requireActivationHandles,
  spyOnHeldFirstFetch,
  WRITE_TOKEN,
} from "../utils.js";
import { buildAppFixture } from "./app.js";

interface TestResponse {
  response: Response;
  body: Buffer;
}

async function listen(app: FastifyInstance): Promise<string> {
  return app.listen({ port: 0, host: "127.0.0.1" });
}

async function send(baseUrl: string, path: string, init?: RequestInit): Promise<TestResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await readResponseAndSettleTransport(response) };
}

describe("fastify integration", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    prepareFirstRequestActivation();
    app = buildAppFixture();
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("exports one SERVER span per request with stable semconv attributes and the {method} {route} span name", async () => {
    prepareFirstRequestActivation();
    const { response } = await send(baseUrl, "/items/42?color=blue", {
      headers: { "user-agent": "test-client" },
    });
    expect(response.status).toBe(200);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
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
      "url.full": `${baseUrl}/items/42?color=blue`,
      "server.address": "127.0.0.1",
      "client.address": "127.0.0.1",
      "user_agent.original": "test-client",
      "http.route": "/items/:id",
      "http.response.status_code": 200,
      "http.response.body.size": Buffer.byteLength(JSON.stringify({ id: 42, name: "Widget" })),
    });
  });

  it("uses the client address resolved by the framework's trust proxy configuration", async () => {
    prepareFirstRequestActivation();
    const proxyApp = fastify({ trustProxy: true });
    useApitally(proxyApp, { writeToken: WRITE_TOKEN });
    proxyApp.get("/items", () => ({ ok: true }));

    await proxyApp.inject({
      method: "GET",
      url: "/items",
      headers: { "x-forwarded-for": "8.8.8.8" },
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["client.address"]).toBe("8.8.8.8");
    await proxyApp.close();
  });

  it("continues the remote trace from a traceparent header and exports the request even when the upstream trace is unsampled", async () => {
    prepareFirstRequestActivation();
    const sampledTraceId = "0af7651916cd43dd8448eb211c80319c";
    const unsampledTraceId = "1bf7651916cd43dd8448eb211c80319d";
    const parentSpanId = "b7ad6b7169203331";
    await app.inject({
      method: "GET",
      url: "/items/1",
      headers: { traceparent: `00-${sampledTraceId}-${parentSpanId}-01` },
    });
    await app.inject({
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
    const lines = captureStderr();
    prepareFirstRequestActivation();
    await send(baseUrl, "/api/nested/abc");
    await send(baseUrl, "/api/v2/deep");
    const { response } = await send(baseUrl, "/nope");
    expect(response.status).toBe(404);

    const spans = await readActivationSpans();
    expect(spans.map((requestSpan) => requestSpan.name)).toEqual([
      "GET /api/nested/:key",
      "GET /api/v2/deep",
      "GET",
    ]);
    expect(spans[2].attributes["http.route"]).toBe("");
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints.map((dataPoint) => dataPoint.attributes["http.route"])).toEqual([
      "/api/nested/:key",
      "/api/v2/deep",
    ]);
    expect(lines).toEqual([]);
  });

  it("excludes health check requests from spans while counting them in the request metrics, and records OPTIONS requests in neither", async () => {
    prepareFirstRequestActivation({ captureRequestBody: true, captureResponseBody: true });
    await send(baseUrl, "/healthz");
    await send(baseUrl, "/items/42", { method: "OPTIONS" });

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/healthz");
  });

  it("records the exception event on the SERVER span for an unhandled route error and exports a 5xx status", async () => {
    prepareFirstRequestActivation();
    const { response } = await send(baseUrl, "/error");
    expect(response.status).toBe(500);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["http.response.status_code"]).toBe(500);
    expect(spans[0].events[0].name).toBe("exception");
    expect(spans[0].events[0].attributes?.["exception.message"]).toBe("boom");
  });

  it("counts validation and server errors independently of trace sampling", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    const { response: validationResponse } = await send(baseUrl, "/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(validationResponse.status).toBe(400);
    const { response: errorResponse } = await send(baseUrl, "/error");
    expect(errorResponse.status).toBe(500);

    expect(await readActivationSpans()).toEqual([]);
    expect(drainValidationErrors()).toEqual([
      {
        method: "POST",
        path: "/validate",
        source: "body",
        field: "name",
        message: "must have required property 'name'",
        type: "required",
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

  it("adopts an active SERVER span from user instrumentation without producing a duplicate and layers capture and metrics on top", async () => {
    const handles = configureAndActivate({ captureResponseBody: true });
    const adoptedApp = fastify();
    const userTracer = trace.getTracer("user-instrumentation");
    adoptedApp.addHook("onRequest", (request, reply, done) => {
      const serverSpan = userTracer.startSpan(request.method, { kind: SpanKind.SERVER });
      reply.raw.once("finish", () => serverSpan.end());
      context.with(trace.setSpan(context.active(), serverSpan), done);
    });
    useApitally(adoptedApp, { writeToken: WRITE_TOKEN, captureResponseBody: true });
    adoptedApp.get<{ Params: { id: string } }>("/items/:id", (request) => ({
      id: Number(request.params.id),
    }));
    const adoptedBaseUrl = await listen(adoptedApp);
    const { body } = await send(adoptedBaseUrl, "/items/5");
    expect(JSON.parse(body.toString())).toEqual({ id: 5 });
    await adoptedApp.close();

    await handles.spanPipeline.forceFlush();
    const spans = readSerializedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].instrumentationScope?.name).toBe("user-instrumentation");
    expect(spans[0].attributes["http.route"]).toBe("/items/:id");
    expect(spans[0].attributes["apitally.response.body"]).toBe(JSON.stringify({ id: 5 }));
    expect(await readActivationDurationDataPoints()).toHaveLength(1);
  });

  it("captures, masks, and redacts request and response bodies per configuration and keeps captured payloads off the live span", async () => {
    let sampledAttributes: Attributes | undefined;
    const options = {
      writeToken: WRITE_TOKEN,
      captureRequestBody: true,
      captureResponseBody: true,
      maskRequestBody: (body: Buffer) => Buffer.from(body.toString().replace("Widget", "Gadget")),
      sampleOnResponse: (requestSpan: { attributes: Attributes }) => {
        sampledAttributes = { ...requestSpan.attributes };
        return true;
      },
    };
    prepareFirstRequestActivation(options);
    const bodyApp = buildAppFixture(options);
    const bodyBaseUrl = await listen(bodyApp);
    const { response } = await send(bodyBaseUrl, "/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Widget", password: "hunter2" }),
    });
    expect(response.status).toBe(201);
    await bodyApp.close();

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["apitally.request.body"]).toBe(
      JSON.stringify({ name: "Gadget", password: "[REDACTED]" }),
    );
    expect(spans[0].attributes["apitally.response.body"]).toBe(
      JSON.stringify({ received: { name: "Widget", password: "[REDACTED]" } }),
    );
    expect(sampledAttributes?.["apitally.request.body"]).toBeUndefined();
    expect(sampledAttributes?.["apitally.response.body"]).toBeUndefined();
  });

  it("reports correct sizes and complete body capture for streaming responses", async () => {
    prepareFirstRequestActivation({ captureResponseBody: true });
    const { body } = await send(baseUrl, "/stream");
    expect(body.toString()).toBe("chunk-1\nchunk-2\nchunk-3\n");

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["http.response.body.size"]).toBe(24);
    expect(spans[0].attributes["apitally.response.body"]).toBe("chunk-1\nchunk-2\nchunk-3\n");
  });

  it("propagates a consumer set in a handler to the metrics dimensions", async () => {
    prepareFirstRequestActivation();
    await send(baseUrl, "/consumer");

    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["apitally.consumer.identifier"]).toBe("acme");
  });

  it("activates on the first request and stays idempotent across repeated useApitally calls", async () => {
    prepareFirstRequestActivation();
    expect(isActivated()).toBe(false);
    useApitally(app, { writeToken: WRITE_TOKEN });
    await send(baseUrl, "/items/1");
    expect(isActivated()).toBe(true);
    await send(baseUrl, "/items/2");
    expect(await readActivationSpans()).toHaveLength(2);
  });

  it("drops spans while keeping metrics with a zero sample rate", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    await send(baseUrl, "/items/3");

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("activates during onReady and emits complete prefixed startup routes", async () => {
    prepareFirstRequestActivation();
    const startupApp = fastify();
    useApitally(startupApp, { writeToken: WRITE_TOKEN });
    startupApp.register(
      (child, _options, done) => {
        child.get("/items/:id", () => ({ ok: true }));
        done();
      },
      { prefix: "/api" },
    );
    await startupApp.ready();
    expect(isActivated()).toBe(true);

    const handles = requireActivationHandles();
    await handles.loggerProvider.forceFlush();
    const records = readSerializedLogRecords();
    const payload = JSON.parse(String(records[0].body)) as {
      framework: string;
      paths: { method: string; path: string }[];
    };
    expect(payload.framework).toBe("fastify");
    expect(payload.paths).toEqual([{ method: "GET", path: "/api/items/:id" }]);
    await startupApp.close();
  });

  it("flushes buffered telemetry when the app closes", async () => {
    prepareFirstRequestActivation();
    const closingApp = fastify();
    useApitally(closingApp, { writeToken: WRITE_TOKEN });
    closingApp.get("/items", () => ({ ok: true }));
    const closingBaseUrl = await listen(closingApp);
    await send(closingBaseUrl, "/items");
    const { fetchSpy, firstFetchObserved, releaseFirstFetch } = spyOnHeldFirstFetch();

    const closePromise = closingApp.close();
    await firstFetchObserved;
    releaseFirstFetch();
    await closePromise;
    expect(readFetchPaths(fetchSpy).sort()).toEqual(["/v1/logs", "/v1/metrics", "/v1/traces"]);
  });

  it("keeps the request context active through Fastify hooks and handlers", async () => {
    prepareFirstRequestActivation();
    const contextApp = fastify();
    useApitally(contextApp, { writeToken: WRITE_TOKEN });
    contextApp.get("/child", () => span("child", () => ({ ok: true })));
    const contextBaseUrl = await listen(contextApp);
    await send(contextBaseUrl, "/child");
    await contextApp.close();

    const spans = await readActivationSpans();
    expect(spans.map((requestSpan) => requestSpan.name)).toEqual(["child", "GET /child"]);
    expect(spans[0].parentSpanContext?.spanId).toBe(spans[1].spanContext().spanId);
  });

  it("treats Fastify validation errors as ordinary 4xx responses", async () => {
    prepareFirstRequestActivation();
    const validationApp = fastify();
    useApitally(validationApp, { writeToken: WRITE_TOKEN });
    validationApp.get(
      "/validated",
      {
        schema: {
          querystring: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
      () => ({ ok: true }),
    );
    const validationBaseUrl = await listen(validationApp);
    const { response } = await send(validationBaseUrl, "/validated");
    expect(response.status).toBe(400);
    await validationApp.close();

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].events).toEqual([]);
  });

  it("bypasses requests carrying a WebSocket upgrade header", async () => {
    prepareFirstRequestActivation();
    const response = await app.inject({
      method: "GET",
      url: "/items/1",
      headers: { upgrade: "WebSocket" },
    });
    expect(response.statusCode).toBe(200);
    expect(await readActivationSpans()).toEqual([]);
    expect(await readActivationDurationDataPoints()).toEqual([]);
  });
});
