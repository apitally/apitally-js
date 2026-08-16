import { server as createHapiServer } from "@hapi/hapi";
import Router from "@koa/router";
import { SpanKind, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Elysia } from "elysia";
import express from "express";
import { fastify } from "fastify";
import { H3 } from "h3";
import { Hono } from "hono";
import Koa from "koa";
import { describe, expect, it } from "vitest";
import {
  ApitallySpanProcessor,
  captureException,
  instrument,
  setConsumer,
  setRequestAttribute,
  shutdown,
  span,
  useApitally,
} from "../src/index.js";
import {
  captureStderr,
  prepareFirstRequestActivation,
  readActivationSpans,
  readResponseAndSettleTransport,
  requireActivationHandles,
  startServerSpan,
  WRITE_TOKEN,
  withServer,
} from "./utils.js";

describe("root entry", () => {
  it("dispatches an Express app to the express integration and exports its SERVER span with the route template", async () => {
    prepareFirstRequestActivation();
    const app = express();
    useApitally(app, { writeToken: WRITE_TOKEN });
    app.get("/items/:id", (_req, res) => {
      res.json({ ok: true });
    });
    await withServer(app, async (_server, baseUrl) => {
      const response = await fetch(`${baseUrl}/items/7`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("dispatches a Fastify app to the fastify integration and exports its SERVER span with the route template", async () => {
    prepareFirstRequestActivation();
    const app = fastify();
    useApitally(app, { writeToken: WRITE_TOKEN });
    app.get<{ Params: { id: string } }>("/items/:id", () => ({ ok: true }));
    const response = await app.inject("/items/7");
    expect(response.statusCode).toBe(200);
    await app.close();

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("dispatches an initialized Hapi server to the hapi integration and exports its SERVER span with the route template", async () => {
    prepareFirstRequestActivation();
    const server = createHapiServer();
    server.route({ method: "GET", path: "/items/{id}", handler: () => ({ ok: true }) });
    await server.initialize();
    expect(() => useApitally(server, { writeToken: WRITE_TOKEN })).not.toThrow();
    const response = await server.inject("/items/7");
    expect(response.statusCode).toBe(200);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    await server.stop();

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/{id}");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].attributes["http.route"]).toBe("/items/{id}");
  });

  it("dispatches an H3 app to the h3 integration and exports its SERVER span with the route template", async () => {
    prepareFirstRequestActivation();
    const app = new H3();
    useApitally(app, { writeToken: WRITE_TOKEN });
    app.get("/items/:id", () => ({ ok: true }));
    const response = await app.request("/items/7");
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("dispatches an Elysia app to the elysia integration before the Hono detector and exports its SERVER span with the route template", async () => {
    prepareFirstRequestActivation();
    const app = new Elysia();
    useApitally(app, { writeToken: WRITE_TOKEN });
    app.get("/items/:id", () => ({ ok: true }));
    const response = await app.handle(new Request("http://localhost/items/7"));
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("dispatches a Hono app to the hono integration and exports its SERVER span with the route template", async () => {
    prepareFirstRequestActivation();
    const app = new Hono();
    useApitally(app, { writeToken: WRITE_TOKEN });
    app.get("/items/:id", (c) => c.json({ ok: true }));
    const response = await app.request("/items/7");
    expect(response.status).toBe(200);
    await readResponseAndSettleTransport(response);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("dispatches a Koa app to the koa integration and exports its SERVER span with the route template", async () => {
    prepareFirstRequestActivation();
    const app = new Koa();
    app.silent = true;
    useApitally(app, { writeToken: WRITE_TOKEN });
    const router = new Router();
    router.get("/items/:id", (ctx) => {
      ctx.body = { ok: true };
    });
    app.use(router.routes());
    await withServer(app.callback(), async (_server, baseUrl) => {
      const response = await fetch(`${baseUrl}/items/7`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items/:id");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].attributes["http.route"]).toBe("/items/:id");
  });

  it("applies the runtime helpers to the current request and resolves shutdown", async () => {
    prepareFirstRequestActivation();
    const app = express();
    useApitally(app, { writeToken: WRITE_TOKEN });
    const fetchItems = instrument(function fetchItems() {
      return 3;
    });
    app.get("/things/:id", (_req, res) => {
      setConsumer("acme");
      setRequestAttribute("tenant.plan", "enterprise");
      captureException(new Error("observed failure"));
      const count = fetchItems();
      const doubled = span("double count", () => count * 2);
      res.json({ doubled });
    });
    await withServer(app, async (_server, baseUrl) => {
      const response = await fetch(`${baseUrl}/things/9`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ doubled: 6 });
    });

    const spans = await readActivationSpans();
    expect(spans.map((exportedSpan) => [exportedSpan.name, exportedSpan.kind])).toEqual([
      ["fetchItems", SpanKind.INTERNAL],
      ["double count", SpanKind.INTERNAL],
      ["GET /things/:id", SpanKind.SERVER],
    ]);
    const serverSpan = spans[2];
    const serverSpanId = serverSpan.spanContext().spanId;
    for (const childSpan of spans.slice(0, 2)) {
      expect(childSpan.parentSpanContext?.spanId).toBe(serverSpanId);
    }
    expect(serverSpan.attributes["apitally.consumer.identifier"]).toBe("acme");
    expect(serverSpan.attributes["tenant.plan"]).toBe("enterprise");
    expect(serverSpan.events).toHaveLength(1);
    expect(serverSpan.events[0].name).toBe("exception");
    expect(serverSpan.events[0].attributes?.["exception.message"]).toBe("observed failure");

    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("exports the first SERVER span from a user provider through ApitallySpanProcessor", async () => {
    prepareFirstRequestActivation();
    const userExporter = new InMemorySpanExporter();
    const userProvider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      resource: resourceFromAttributes({ "deployment.environment.name": "staging" }),
      spanProcessors: [new SimpleSpanProcessor(userExporter), new ApitallySpanProcessor()],
    });
    trace.setGlobalTracerProvider(userProvider);

    const { span: serverSpan, request } = startServerSpan(
      userProvider.getTracer("user-instrumentation"),
    );
    serverSpan.end();
    const handles = requireActivationHandles();
    handles.spanPipeline.handleTransportCompletion(request.record);

    const exportedSpans = await readActivationSpans();
    expect(exportedSpans).toHaveLength(1);
    expect(exportedSpans[0].name).toBe("GET /items");
    expect(exportedSpans[0].kind).toBe(SpanKind.SERVER);
    expect(exportedSpans[0].resource.attributes["deployment.environment.name"]).toBe("staging");
    expect(userExporter.getFinishedSpans().map((span) => span.name)).toEqual(["GET /items"]);
  });

  it("warns once when a declared ApitallySpanProcessor is not attached", async () => {
    const lines = captureStderr();
    prepareFirstRequestActivation();
    const userProvider = new NodeTracerProvider({ sampler: new AlwaysOnSampler() });
    trace.setGlobalTracerProvider(userProvider);
    const unattachedProcessor = new ApitallySpanProcessor();
    const app = new Hono();
    useApitally(app, { writeToken: WRITE_TOKEN });
    app.get("/items", (c) => c.json({ ok: true }));

    for (let index = 0; index < 2; index += 1) {
      const response = await app.request("/items");
      await readResponseAndSettleTransport(response);
    }
    await unattachedProcessor.forceFlush();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("did not reach ApitallySpanProcessor");
    expect(await readActivationSpans()).toEqual([]);
  });
});
