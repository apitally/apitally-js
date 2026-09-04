import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { AppFactory } from "@adonisjs/core/factories/app";
import type { ApplicationService } from "@adonisjs/core/types";
import { type Attributes, context, SpanKind, trace } from "@opentelemetry/api";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { isActivated } from "../../src/activation.js";
import ApitallyProvider from "../../src/adonisjs/provider.js";
import { type ApitallyOptions, getConfig } from "../../src/config.js";
import { resolvePackageVersion } from "../../src/packageVersion.js";
import { drainServerErrors } from "../../src/serverErrors.js";
import { drainValidationErrors } from "../../src/validationErrors.js";
import {
  captureStderr,
  clearTestRunnerMarkers,
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
  waitForNextRequestFinish,
  withServer,
} from "../utils.js";
import { buildAppFixture } from "./app.js";

interface TestResponse {
  response: Response;
  body: Buffer;
}

type Listener = (request: IncomingMessage, response: ServerResponse) => void;

async function send(baseUrl: string, path: string, init?: RequestInit): Promise<TestResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await readResponseAndSettleTransport(response) };
}

async function withApp(
  options: ApitallyOptions,
  run: (baseUrl: string, server: Server) => Promise<void>,
  wrapListener?: (listener: Listener) => Listener,
  trustProxy = false,
): Promise<void> {
  const fixture = await buildAppFixture(options, trustProxy);
  const listener = fixture.server.handle.bind(fixture.server);
  try {
    await withServer(wrapListener ? wrapListener(listener) : listener, async (server, baseUrl) => {
      await run(baseUrl, server);
    });
  } finally {
    await fixture.app.terminate();
  }
}

describe("adonisjs integration", () => {
  it("exports one SERVER span per request with stable semconv attributes and the {method} {route} span name", async () => {
    prepareFirstRequestActivation();
    await withApp({}, async (baseUrl) => {
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
  });

  it("uses the client address resolved by the framework's trust proxy configuration", async () => {
    prepareFirstRequestActivation();
    await withApp(
      {},
      async (baseUrl) => {
        const { response } = await send(baseUrl, "/items/42", {
          headers: { "x-forwarded-for": "8.8.8.8" },
        });
        expect(response.status).toBe(200);

        const spans = await readActivationSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].attributes["client.address"]).toBe("8.8.8.8");
      },
      undefined,
      true,
    );
  });

  it("continues the remote trace from a traceparent header and exports the request even when the upstream trace is unsampled", async () => {
    prepareFirstRequestActivation();
    await withApp({}, async (_baseUrl, server) => {
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
      expect(spans.map((span) => span.spanContext().traceId)).toEqual([
        sampledTraceId,
        unsampledTraceId,
      ]);
      for (const span of spans) {
        expect(span.parentSpanContext?.spanId).toBe(parentSpanId);
      }
    });
  });

  it("includes mount prefixes in route templates for nested routers and exports unmatched requests with a cleared route skipped by the request metrics", async () => {
    const lines = captureStderr();
    prepareFirstRequestActivation();
    await withApp({}, async (baseUrl) => {
      await send(baseUrl, "/api/nested/abc");
      await send(baseUrl, "/api/v2/deep");
      const { response } = await send(baseUrl, "/nope");
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
  });

  it("excludes health check requests from spans while counting them in the request metrics, and records OPTIONS requests in neither", async () => {
    const options = { captureRequestBody: true, captureResponseBody: true };
    prepareFirstRequestActivation(options);
    await withApp(options, async (baseUrl) => {
      await send(baseUrl, "/healthz");
      await send(baseUrl, "/items/42", { method: "OPTIONS" });

      expect(await readActivationSpans()).toEqual([]);
      const dataPoints = await readActivationDurationDataPoints();
      expect(dataPoints).toHaveLength(1);
      expect(dataPoints[0].attributes["http.route"]).toBe("/healthz");
    });
  });

  it("records the exception event on the SERVER span for an unhandled route error and exports a 5xx status", async () => {
    prepareFirstRequestActivation();
    await withApp({}, async (baseUrl) => {
      const { response } = await send(baseUrl, "/error");
      expect(response.status).toBe(500);

      const spans = await readActivationSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("GET /error");
      expect(spans[0].attributes["http.response.status_code"]).toBe(500);
      expect(spans[0].events[0].name).toBe("exception");
      expect(spans[0].events[0].attributes?.["exception.message"]).toBe("boom");
    });
  });

  it("counts validation and server errors independently of trace sampling", async () => {
    const options = { sampleRate: 0 };
    prepareFirstRequestActivation(options);
    await withApp(options, async (baseUrl) => {
      const { response: validationResponse } = await send(baseUrl, "/validate", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      expect(validationResponse.status).toBe(422);
      const { response: errorResponse } = await send(baseUrl, "/error");
      expect(errorResponse.status).toBe(500);

      expect(await readActivationSpans()).toEqual([]);
      expect(drainValidationErrors()).toEqual([
        {
          method: "POST",
          path: "/validate",
          source: "",
          field: "name",
          message: "The name field must be defined",
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
  });

  it("adopts an active SERVER span from user instrumentation without producing a duplicate and layers capture and metrics on top", async () => {
    const options = { captureResponseBody: true };
    const handles = configureAndActivate(options);
    const userTracer = trace.getTracer("user-instrumentation");
    await withApp(
      options,
      async (baseUrl) => {
        const released = waitForNextRequestFinish(handles.spanPipeline);
        const { body } = await send(baseUrl, "/items/5");
        expect(JSON.parse(body.toString())).toEqual({ id: 5, name: "Widget" });
        await released;
      },
      (listener) => (request, response) => {
        const serverSpan = userTracer.startSpan(request.method ?? "GET", {
          kind: SpanKind.SERVER,
        });
        response.once("finish", () => serverSpan.end());
        context.with(trace.setSpan(context.active(), serverSpan), () =>
          listener(request, response),
        );
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
      captureRequestBody: true,
      captureResponseBody: true,
      maskRequestBody: (body: Buffer) => Buffer.from(body.toString().replace("Widget", "Gadget")),
      sampleOnResponse: (requestSpan: { attributes: Attributes }) => {
        sampledAttributes = { ...requestSpan.attributes };
        return true;
      },
    };
    prepareFirstRequestActivation(options);
    await withApp(options, async (baseUrl) => {
      const { response } = await send(baseUrl, "/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Widget", password: "hunter2" }),
      });
      expect(response.status).toBe(201);

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
  });

  it("reports correct sizes and complete body capture for streaming responses", async () => {
    const options = { captureResponseBody: true };
    prepareFirstRequestActivation(options);
    await withApp(options, async (baseUrl) => {
      const { body } = await send(baseUrl, "/stream");
      expect(body.toString()).toBe("chunk-1\nchunk-2\nchunk-3\n");

      const spans = await readActivationSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes["http.response.body.size"]).toBe(24);
      expect(spans[0].attributes["apitally.response.body"]).toBe("chunk-1\nchunk-2\nchunk-3\n");
    });
  });

  it("propagates a consumer set in a handler to the metrics dimensions", async () => {
    prepareFirstRequestActivation();
    await withApp({}, async (baseUrl) => {
      await send(baseUrl, "/consumer");

      const dataPoints = await readActivationDurationDataPoints();
      expect(dataPoints).toHaveLength(1);
      expect(dataPoints[0].attributes["apitally.consumer.identifier"]).toBe("acme");
    });
  });

  it("drops spans while keeping metrics with a zero sample rate", async () => {
    const options = { sampleRate: 0 };
    prepareFirstRequestActivation(options);
    await withApp(options, async (baseUrl) => {
      await send(baseUrl, "/items/3");

      expect(await readActivationSpans()).toEqual([]);
      const dataPoints = await readActivationDurationDataPoints();
      expect(dataPoints).toHaveLength(1);
      expect(dataPoints[0].attributes["http.route"]).toBe("/items/:id");
    });
  });

  it("activates from the web application ready lifecycle and emits complete startup metadata", async () => {
    const options = { appVersion: "1.2.3" };
    prepareFirstRequestActivation(options);
    const fixture = await buildAppFixture(options);
    try {
      expect(isActivated()).toBe(true);
      const handles = requireActivationHandles();
      await handles.loggerProvider.forceFlush();
      const startupRecord = readSerializedLogRecords().find(
        (record) => record.eventName === "apitally.app.startup",
      );
      expect(startupRecord).toBeDefined();
      expect(JSON.parse(String(startupRecord?.body))).toEqual({
        framework: "adonisjs",
        versions: {
          node: process.versions.node,
          adonisjs: resolvePackageVersion("@adonisjs/core"),
          app: "1.2.3",
        },
        paths: [
          { method: "GET", path: "/items/:id" },
          { method: "POST", path: "/items" },
          { method: "GET", path: "/healthz" },
          { method: "GET", path: "/error" },
          { method: "POST", path: "/validate" },
          { method: "GET", path: "/consumer" },
          { method: "GET", path: "/stream" },
          { method: "GET", path: "/api/nested/:key" },
          { method: "GET", path: "/api/v2/deep" },
        ],
      });
    } finally {
      await fixture.app.terminate();
    }
  });

  it("configures without activating or resolving the router outside the web environment", async () => {
    clearTestRunnerMarkers();
    const app = new AppFactory()
      .merge({ environment: "console" })
      .create(new URL("./tmp-console/", import.meta.url)) as ApplicationService;
    app.useConfig({ apitally: { writeToken: WRITE_TOKEN } });
    await app.init();
    await app.boot();
    const provider = new ApitallyProvider(app);
    const makeSpy = vi.spyOn(app.container, "make");

    provider.register();
    await provider.ready();

    expect(getConfig().writeToken).toBe(WRITE_TOKEN);
    expect(isActivated()).toBe(false);
    expect(makeSpy).not.toHaveBeenCalled();
  });

  it("drains buffered telemetry when the application closes", async () => {
    prepareFirstRequestActivation();
    const fixture = await buildAppFixture();
    let hasTerminated = false;
    try {
      await withServer(fixture.server.handle.bind(fixture.server), async (_server, baseUrl) => {
        await send(baseUrl, "/items/6");
      });
      const { fetchSpy, firstFetchObserved, releaseFirstFetch } = spyOnHeldFirstFetch();
      const terminatePromise = fixture.app.terminate();
      await firstFetchObserved;
      releaseFirstFetch();
      await terminatePromise;
      hasTerminated = true;
      expect(readFetchPaths(fetchSpy).sort()).toEqual(["/v1/logs", "/v1/metrics", "/v1/traces"]);
    } finally {
      if (!hasTerminated) {
        await fixture.app.terminate();
      }
    }
  });
});
