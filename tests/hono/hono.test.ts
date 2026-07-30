import { gunzipSync } from "node:zlib";
import { type Attributes, context, SpanKind, TraceFlags, trace } from "@opentelemetry/api";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { isActivated } from "../../src/activation.js";
import { useApitally } from "../../src/hono/index.js";
import {
  captureStderr,
  configureAndActivate,
  prepareFirstRequestActivation,
  readActivationDurationDataPoints,
  readActivationSpans,
  readResponseAndSettleTransport,
  readSerializedSpans,
  WRITE_TOKEN,
  waitForNextRequestFinish,
} from "../utils.js";
import { buildAppFixture } from "./app.js";

describe("hono adapter", () => {
  let app: Hono;

  beforeAll(() => {
    // The fixture's useApitally call resolves the same configuration the first
    // test configures, so the first-call-wins rule never sees a conflict.
    prepareFirstRequestActivation();
    app = buildAppFixture();
  });

  it("exports one SERVER span per request with stable semconv attributes and the {method} {route} span name", async () => {
    prepareFirstRequestActivation();
    const response = await app.request("/items/42?color=blue");
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    const attributes = spans[0].attributes;
    expect(attributes["http.response.header.content-type"]).toEqual(["application/json"]);
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
    const sampledResponse = await app.request("/items/1", {
      headers: { traceparent: `00-${sampledTraceId}-${parentSpanId}-01` },
    });
    expect(sampledResponse.status).toBe(200);
    await readResponseAndSettleTransport(sampledResponse);
    const unsampledResponse = await app.request("/items/2", {
      headers: { traceparent: `00-${unsampledTraceId}-${parentSpanId}-00` },
    });
    expect(unsampledResponse.status).toBe(200);
    await readResponseAndSettleTransport(unsampledResponse);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(2);
    const traceIds = spans.map((span) => span.spanContext().traceId);
    expect(traceIds).toEqual([sampledTraceId, unsampledTraceId]);
    for (const span of spans) {
      expect(span.parentSpanContext?.spanId).toBe(parentSpanId);
    }
  });

  it("includes mount prefixes in route templates for nested routers and exports unmatched requests with a cleared route skipped by the request metrics", async () => {
    const lines = captureStderr();
    prepareFirstRequestActivation();
    const nestedResponse = await app.request("/api/nested/abc");
    expect(nestedResponse.status).toBe(200);
    await readResponseAndSettleTransport(nestedResponse);
    const deepResponse = await app.request("/api/v2/deep");
    expect(deepResponse.status).toBe(200);
    await readResponseAndSettleTransport(deepResponse);
    const unmatchedResponse = await app.request("/nope");
    expect(unmatchedResponse.status).toBe(404);
    await readResponseAndSettleTransport(unmatchedResponse);

    const spans = await readActivationSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "GET /api/nested/:key",
      "GET /api/v2/deep",
      "GET",
    ]);
    const unmatchedAttributes = spans[2].attributes;
    expect(unmatchedAttributes["http.route"]).toBe("");
    expect(unmatchedAttributes["http.response.status_code"]).toBe(404);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints.map((dataPoint) => dataPoint.attributes["http.route"])).toEqual([
      "/api/nested/:key",
      "/api/v2/deep",
    ]);
    expect(lines).toEqual([]);
  });

  it("excludes health check requests from spans while counting them in the request metrics, and records OPTIONS requests in neither", async () => {
    // Capture stays enabled so excluded requests provably export no payloads.
    prepareFirstRequestActivation({
      captureRequestBody: true,
      captureResponseBody: true,
    });
    const healthzResponse = await app.request("/healthz");
    expect(healthzResponse.status).toBe(200);
    await readResponseAndSettleTransport(healthzResponse);
    const optionsResponse = await app.request("/items/42", {
      method: "OPTIONS",
    });
    await readResponseAndSettleTransport(optionsResponse);

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/healthz");
    expect(dataPoints[0].value.count).toBe(1);
  });

  it("records the exception event on the SERVER span for an unhandled route error and exports a 5xx status", async () => {
    prepareFirstRequestActivation();
    const response = await app.request("/error");
    expect(response.status).toBe(500);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /error");
    expect(spans[0].attributes["http.response.status_code"]).toBe(500);
    expect(spans[0].events).toHaveLength(1);
    expect(spans[0].events[0].name).toBe("exception");
    const eventAttributes = spans[0].events[0].attributes ?? {};
    expect(eventAttributes["exception.type"]).toBe("Error");
    expect(eventAttributes["exception.message"]).toBe("boom");
    expect(typeof eventAttributes["exception.stacktrace"]).toBe("string");
  });

  it("rethrows a synchronous dispatch failure unchanged and releases its span", async () => {
    const handles = configureAndActivate();
    const failure = new Error("sync dispatch failed");
    const failedApp = new Hono();
    (failedApp as unknown as { fetch: () => Response }).fetch = () => {
      throw failure;
    };
    useApitally(failedApp, { writeToken: WRITE_TOKEN });
    const released = waitForNextRequestFinish(handles.spanPipeline);

    expect(() => failedApp.fetch(new Request("http://localhost/fail"))).toThrow(failure);
    await released;

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].events[0].attributes?.["exception.message"]).toBe("sync dispatch failed");
  });

  it("rethrows an asynchronous dispatch failure unchanged and releases its span", async () => {
    const handles = configureAndActivate();
    const failure = new Error("async dispatch failed");
    const failedApp = new Hono();
    (failedApp as unknown as { fetch: () => Promise<Response> }).fetch = () =>
      Promise.reject(failure);
    useApitally(failedApp, { writeToken: WRITE_TOKEN });
    const released = waitForNextRequestFinish(handles.spanPipeline);

    await expect(failedApp.fetch(new Request("http://localhost/fail"))).rejects.toBe(failure);
    await released;

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].events[0].attributes?.["exception.message"]).toBe("async dispatch failed");
  });

  it("adopts an active SERVER span from user instrumentation without producing a duplicate and layers capture and metrics on top", async () => {
    const handles = configureAndActivate({ captureResponseBody: true });
    const adoptedApp = buildAppFixture({ captureResponseBody: true });
    const userTracer = trace.getTracer("user-instrumentation");
    const appWithFetch = adoptedApp as unknown as {
      fetch: (request: Request, ...rest: unknown[]) => Promise<Response>;
    };
    const sdkFetch = appWithFetch.fetch;
    appWithFetch.fetch = function (
      this: unknown,
      request: Request,
      ...rest: unknown[]
    ): Promise<Response> {
      const url = new URL(request.url);
      const span = userTracer.startSpan(request.method, {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": request.method,
          "url.path": url.pathname,
          "url.scheme": "http",
        },
      });
      return context.with(trace.setSpan(context.active(), span), async (): Promise<Response> => {
        const response = await sdkFetch.call(this, request, ...rest);
        span.end();
        return response;
      });
    };
    const released = waitForNextRequestFinish(handles.spanPipeline);
    const response = await adoptedApp.request("/items/5");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 5, name: "Widget" });
    await released;

    await handles.spanPipeline.forceFlush();
    const spans = readSerializedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].instrumentationScope?.name).toBe("user-instrumentation");
    const attributes = spans[0].attributes;
    expect(attributes["http.route"]).toBe("/items/:id");
    expect(attributes["http.response.status_code"]).toBe(200);
    expect(attributes["apitally.response.body"]).toBe(JSON.stringify({ id: 5, name: "Widget" }));
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("warns once about partial trace coverage when a request arrives under an unsampled span context while metrics keep recording", async () => {
    configureAndActivate();
    const lines = captureStderr();
    const unsampledApp = new Hono();
    useApitally(unsampledApp, { writeToken: WRITE_TOKEN });
    unsampledApp.get("/unsampled", (c) => c.json({ ok: true }));
    const appWithFetch = unsampledApp as unknown as {
      fetch: (request: Request, ...rest: unknown[]) => Promise<Response>;
    };
    const sdkFetch = appWithFetch.fetch;
    const unsampledSpan = trace.wrapSpanContext({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.NONE,
    });
    appWithFetch.fetch = function (
      this: unknown,
      request: Request,
      ...rest: unknown[]
    ): Promise<Response> {
      return context.with(trace.setSpan(context.active(), unsampledSpan), () =>
        sdkFetch.call(this, request, ...rest),
      );
    };
    for (let i = 0; i < 2; i++) {
      const response = await unsampledApp.request("/unsampled");
      expect(response.status).toBe(200);
      await readResponseAndSettleTransport(response);
    }

    expect(lines.filter((line) => line.includes("did not sample"))).toHaveLength(1);
    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].value.count).toBe(2);
    expect(dataPoints[0].attributes["http.route"]).toBe("/unsampled");
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
    const response = await app.request("/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Widget", password: "hunter2" }),
    });
    expect(response.status).toBe(201);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    const attributes = spans[0].attributes;
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
    const response = await app.request("/stream");
    expect(response.status).toBe(200);
    const body = await readResponseAndSettleTransport(response);
    expect(body.toString()).toBe("chunk-1\nchunk-2\nchunk-3\n");

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    const attributes = spans[0].attributes;
    expect(attributes["http.response.body.size"]).toBe(24);
    expect(attributes["apitally.response.body"]).toBe("chunk-1\nchunk-2\nchunk-3\n");
  });

  it("captures the compressed wire bytes of the response body with matching size attributes when compression middleware is active", async () => {
    prepareFirstRequestActivation({ captureResponseBody: true });
    const compressedApp = new Hono();
    useApitally(compressedApp, {
      writeToken: WRITE_TOKEN,
      captureResponseBody: true,
    });
    compressedApp.use(compress());
    const payload = { data: "x".repeat(2048) };
    compressedApp.get("/compressed", (c) => c.json(payload));
    const response = await compressedApp.request("/compressed", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const wireBytes = await readResponseAndSettleTransport(response);
    expect(gunzipSync(wireBytes).toString()).toBe(JSON.stringify(payload));

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    const attributes = spans[0].attributes;
    const capturedResponseBody = attributes["apitally.response.body"];
    if (!(capturedResponseBody instanceof Uint8Array)) {
      throw new Error("Expected a byte-valued response body");
    }
    expect(Buffer.from(capturedResponseBody).equals(wireBytes)).toBe(true);
    expect(attributes["http.response.body.size"]).toBe(wireBytes.length);
  });

  it("propagates a consumer set in a handler to the metrics dimensions", async () => {
    prepareFirstRequestActivation();
    const response = await app.request("/consumer");
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);

    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes).toEqual({
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
    const firstResponse = await app.request("/items/1");
    expect(firstResponse.status).toBe(200);
    await readResponseAndSettleTransport(firstResponse);
    expect(isActivated()).toBe(true);
    const secondResponse = await app.request("/items/2");
    expect(secondResponse.status).toBe(200);
    await readResponseAndSettleTransport(secondResponse);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(2);
  });

  it("drops spans while keeping metrics with a zero sample rate", async () => {
    prepareFirstRequestActivation({ sampleRate: 0 });
    const response = await app.request("/items/3");
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);

    expect(await readActivationSpans()).toEqual([]);
    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("runs the wrapped onError handler and records the exception event even when it was registered after useApitally", async () => {
    prepareFirstRequestActivation();
    const errorApp = new Hono();
    useApitally(errorApp, { writeToken: WRITE_TOKEN });
    errorApp.onError((error, c) => c.json({ handled: error.message }, 503));
    errorApp.get("/fail", () => {
      throw new Error("bad");
    });
    const response = await errorApp.request("/fail");
    expect(response.status).toBe(503);
    const body = await readResponseAndSettleTransport(response);
    expect(JSON.parse(body.toString())).toEqual({ handled: "bad" });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /fail");
    expect(spans[0].attributes["http.response.status_code"]).toBe(503);
    expect(spans[0].events).toHaveLength(1);
    expect(spans[0].events[0].name).toBe("exception");
    expect(spans[0].events[0].attributes?.["exception.message"]).toBe("bad");
  });

  it("warns once about routes registered before useApitally and exports their requests with a cleared route skipped by the request metrics", async () => {
    const lines = captureStderr();
    prepareFirstRequestActivation();
    const lateApp = new Hono();
    lateApp.get("/early/:id", (c) => c.json({ ok: true }));
    useApitally(lateApp, { writeToken: WRITE_TOKEN });
    const secondLateApp = new Hono();
    secondLateApp.get("/late/:id", (c) => c.json({ ok: true }));
    useApitally(secondLateApp, { writeToken: WRITE_TOKEN });
    const response = await lateApp.request("/early/1");
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET");
    expect(spans[0].attributes["http.route"]).toBe("");
    expect(await readActivationDurationDataPoints()).toEqual([]);
    const orderingWarnings = lines.filter((line) =>
      line.includes("immediately after creating the app"),
    );
    expect(orderingWarnings).toHaveLength(1);
  });

  it("captures a request body read via c.req.json() byte-identical to the wire and skips bodies consumed via parseBody", async () => {
    let observedWireBody: string | undefined;
    const options = {
      writeToken: WRITE_TOKEN,
      captureRequestBody: true,
      maskRequestBody: (body: Buffer) => {
        observedWireBody = body.toString();
        return body;
      },
    };
    prepareFirstRequestActivation(options);
    const bodyApp = new Hono();
    useApitally(bodyApp, options);
    bodyApp.post("/json", async (c) => {
      const payload: unknown = await c.req.json();
      return c.json({ ok: payload !== undefined });
    });
    bodyApp.post("/form", async (c) => {
      const fields = await c.req.parseBody();
      return c.json({ fields: Object.keys(fields) });
    });
    const wireBody = '{ "b" : 2,\n  "a": 1 }';
    const jsonResponse = await bodyApp.request("/json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: wireBody,
    });
    expect(jsonResponse.status).toBe(200);
    await readResponseAndSettleTransport(jsonResponse);
    const formData = new FormData();
    formData.append("name", "Widget");
    const formResponse = await bodyApp.request("/form", {
      method: "POST",
      body: formData,
    });
    expect(formResponse.status).toBe(200);
    const formResponseBody = await readResponseAndSettleTransport(formResponse);
    expect(JSON.parse(formResponseBody.toString())).toEqual({
      fields: ["name"],
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(2);
    // The callback receives original wire bytes, proving capture used a cache
    // entry that preserves those bytes.
    expect(observedWireBody).toBe(wireBody);
    const jsonAttributes = spans[0].attributes;
    expect(jsonAttributes["apitally.request.body"]).toBe('{"b":2,"a":1}');
    expect(jsonAttributes["http.request.body.size"]).toBe(Buffer.byteLength(wireBody));
    const formAttributes = spans[1].attributes;
    expect(formAttributes["apitally.request.body"]).toBeUndefined();
  });

  it("excludes asynchronous request-body cache recovery from request duration", async () => {
    const handles = configureAndActivate({ captureRequestBody: true });
    const durationApp = new Hono();
    useApitally(durationApp, {
      writeToken: WRITE_TOKEN,
      captureRequestBody: true,
    });
    let releaseCachedBody = (_body: ArrayBuffer) => {};
    const cachedBody = new Promise<ArrayBuffer>((resolve) => {
      releaseCachedBody = resolve;
    });
    durationApp.post("/duration", (c) => {
      (c.req.bodyCache as Record<string, unknown>).arrayBuffer = cachedBody;
      return c.json({ ok: true });
    });
    const released = waitForNextRequestFinish(handles.spanPipeline);

    const response = await durationApp.request("/duration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"Widget"}',
    });
    await readResponseAndSettleTransport(response);
    const delayedNow = performance.now() + 60_000;
    vi.spyOn(performance, "now").mockReturnValue(delayedNow);
    releaseCachedBody(new TextEncoder().encode('{"name":"Widget"}').buffer);
    await released;

    const dataPoints = await readActivationDurationDataPoints();
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].value.sum).toBeLessThan(30);
  });

  it("clears the route for a custom notFound response and skips the request in the metrics", async () => {
    prepareFirstRequestActivation();
    const notFoundApp = new Hono();
    useApitally(notFoundApp, { writeToken: WRITE_TOKEN });
    notFoundApp.notFound((c) => c.json({ error: "missing" }, 404));
    notFoundApp.get("/known", (c) => c.json({ ok: true }));
    const response = await notFoundApp.request("/unknown");
    expect(response.status).toBe(404);
    const body = await readResponseAndSettleTransport(response);
    expect(JSON.parse(body.toString())).toEqual({ error: "missing" });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET");
    const attributes = spans[0].attributes;
    expect(attributes["http.route"]).toBe("");
    expect(attributes["http.response.status_code"]).toBe(404);
    expect(await readActivationDurationDataPoints()).toEqual([]);
  });
});
