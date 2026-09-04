import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Attributes, context, SpanKind, trace } from "@opentelemetry/api";
import Koa from "koa";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isActivated } from "../../src/activation.js";
import { useApitally } from "../../src/koa/index.js";
import { drainServerErrors } from "../../src/serverErrors.js";
import {
  captureStderr,
  configureAndActivate,
  prepareFirstRequestActivation,
  readActivationDurationDataPoints,
  readActivationSpans,
  readFetchPaths,
  readResponseAndSettleTransport,
  readSerializedSpans,
  requireActivationHandles,
  spyOnHeldFirstFetch,
  WRITE_TOKEN,
  waitForNextRequestFinish,
  withServer,
} from "../utils.js";
import { buildAppFixture } from "./app.js";

interface TestServer {
  server: Server;
  baseUrl: string;
}

interface TestResponse {
  response: Response;
  body: Buffer;
}

async function listen(app: Koa): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function send(baseUrl: string, path: string, init?: RequestInit): Promise<TestResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await readResponseAndSettleTransport(response) };
}

describe("koa integration", () => {
  let app: Koa;
  let testServer: TestServer;

  beforeAll(async () => {
    prepareFirstRequestActivation();
    app = buildAppFixture();
    testServer = await listen(app);
  });

  afterAll(async () => {
    await closeServer(testServer.server);
  });

  it("exports one SERVER span per request with stable semconv attributes and the {method} {route} span name", async () => {
    prepareFirstRequestActivation();
    const { response } = await send(testServer.baseUrl, "/items/42?color=blue", {
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
      "url.full": `${testServer.baseUrl}/items/42?color=blue`,
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
    const proxyApp = new Koa();
    proxyApp.proxy = true;
    useApitally(proxyApp, { writeToken: WRITE_TOKEN });
    proxyApp.use((ctx) => {
      ctx.body = { ok: true };
    });

    await request(proxyApp.callback()).get("/items").set("x-forwarded-for", "8.8.8.8").expect(200);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["client.address"]).toBe("8.8.8.8");
  });

  it("continues the remote trace from a traceparent header and exports the request even when the upstream trace is unsampled", async () => {
    prepareFirstRequestActivation();
    const sampledTraceId = "0af7651916cd43dd8448eb211c80319c";
    const unsampledTraceId = "1bf7651916cd43dd8448eb211c80319d";
    const parentSpanId = "b7ad6b7169203331";
    await request(testServer.server)
      .get("/items/1")
      .set("traceparent", `00-${sampledTraceId}-${parentSpanId}-01`)
      .expect(200);
    await request(testServer.server)
      .get("/items/2")
      .set("traceparent", `00-${unsampledTraceId}-${parentSpanId}-00`)
      .expect(200);

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
    const lines = captureStderr();
    prepareFirstRequestActivation();
    await send(testServer.baseUrl, "/api/nested/abc");
    await send(testServer.baseUrl, "/api/v2/deep");
    const { response } = await send(testServer.baseUrl, "/nope");
    expect(response.status).toBe(404);

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
    expect(lines).toEqual([]);
  });

  it("excludes health check requests from spans while counting them in the request metrics, and records OPTIONS requests in neither", async () => {
    prepareFirstRequestActivation({ captureRequestBody: true, captureResponseBody: true });
    await send(testServer.baseUrl, "/healthz");
    await send(testServer.baseUrl, "/items/42", { method: "OPTIONS" });

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/healthz");
  });

  it("records the exception event on the SERVER span for an unhandled route error and exports a 5xx status", async () => {
    prepareFirstRequestActivation();
    const { response } = await send(testServer.baseUrl, "/error");
    expect(response.status).toBe(500);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /error");
    expect(spans[0].attributes["http.response.status_code"]).toBe(500);
    expect(spans[0].events[0].name).toBe("exception");
    expect(spans[0].events[0].attributes?.["exception.message"]).toBe("boom");
  });

  it("counts server errors independently of trace sampling", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    const { response } = await send(testServer.baseUrl, "/error");
    expect(response.status).toBe(500);

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

  it("does not record an exception event for an expected 4xx route error", async () => {
    prepareFirstRequestActivation();
    const clientErrorApp = new Koa();
    clientErrorApp.silent = true;
    useApitally(clientErrorApp, { writeToken: WRITE_TOKEN });
    clientErrorApp.use((ctx) => ctx.throw(401, "authentication required"));

    await request(clientErrorApp.callback()).get("/private").expect(401);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["http.response.status_code"]).toBe(401);
    expect(spans[0].events).toEqual([]);
  });

  it("adopts an active SERVER span from user instrumentation without producing a duplicate and layers capture and metrics on top", async () => {
    const handles = configureAndActivate({ captureResponseBody: true });
    const adoptedApp = buildAppFixture({ captureResponseBody: true });
    const callback = adoptedApp.callback();
    const userTracer = trace.getTracer("user-instrumentation");
    await withServer(
      (request, response) => {
        const serverSpan = userTracer.startSpan(request.method ?? "GET", {
          kind: SpanKind.SERVER,
        });
        response.once("finish", () => serverSpan.end());
        context.with(trace.setSpan(context.active(), serverSpan), () =>
          callback(request, response),
        );
      },
      async (_server, baseUrl) => {
        const released = waitForNextRequestFinish(handles.spanPipeline);
        const { body } = await send(baseUrl, "/items/5");
        expect(JSON.parse(body.toString())).toEqual({ id: 5, name: "Widget" });
        await released;
      },
    );

    await handles.spanPipeline.forceFlush();
    const spans = readSerializedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].instrumentationScope?.name).toBe("user-instrumentation");
    expect(spans[0].attributes["http.route"]).toBe("/items/:id");
    expect(spans[0].attributes["apitally.response.body"]).toBe(
      JSON.stringify({ id: 5, name: "Widget" }),
    );
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
    await withServer(bodyApp.callback(), async (_server, baseUrl) => {
      const { response } = await send(baseUrl, "/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Widget", password: "hunter2" }),
      });
      expect(response.status).toBe(201);
    });

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
    const { body } = await send(testServer.baseUrl, "/stream");
    expect(body.toString()).toBe("chunk-1\nchunk-2\nchunk-3\n");

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["http.response.body.size"]).toBe(24);
    expect(spans[0].attributes["apitally.response.body"]).toBe("chunk-1\nchunk-2\nchunk-3\n");
  });

  it("propagates a consumer set in a handler to the metrics dimensions", async () => {
    prepareFirstRequestActivation();
    await send(testServer.baseUrl, "/consumer");

    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["apitally.consumer.identifier"]).toBe("acme");
  });

  it("activates on the first request and stays idempotent across repeated useApitally calls", async () => {
    prepareFirstRequestActivation();
    expect(isActivated()).toBe(false);
    useApitally(app, { writeToken: WRITE_TOKEN });
    await send(testServer.baseUrl, "/items/1");
    expect(isActivated()).toBe(true);
    await send(testServer.baseUrl, "/items/2");
    expect(await readActivationSpans()).toHaveLength(2);
  });

  it("drops spans while keeping metrics with a zero sample rate", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    await send(testServer.baseUrl, "/items/3");

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("warns once when useApitally is called after existing middleware", () => {
    const lines = captureStderr();
    prepareFirstRequestActivation();
    for (let index = 0; index < 2; index += 1) {
      const lateApp = new Koa();
      lateApp.use(async (_ctx, next) => next());
      useApitally(lateApp, { writeToken: WRITE_TOKEN });
    }

    const warnings = lines.filter((line) => line.includes("immediately after creating the app"));
    expect(warnings).toHaveLength(1);
  });

  it("flushes buffered telemetry when the underlying server closes", async () => {
    prepareFirstRequestActivation();
    const closingApp = buildAppFixture();
    const closingServer = await listen(closingApp);
    try {
      await send(closingServer.baseUrl, "/items/6");
      const { fetchSpy, firstFetchObserved, releaseFirstFetch } = spyOnHeldFirstFetch();
      const worker = requireActivationHandles().worker;
      await closeServer(closingServer.server);
      await firstFetchObserved;
      const joinedCycle = worker.runCycle();
      releaseFirstFetch();
      await joinedCycle;
      expect(readFetchPaths(fetchSpy).sort()).toEqual(["/v1/logs", "/v1/metrics", "/v1/traces"]);
    } finally {
      await closeServer(closingServer.server);
    }
  });
});
