import { SpanKind } from "@opentelemetry/api";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import express from "express";
import { Hono } from "hono";
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
  configureAndActivate,
  prepareFirstRequestActivation,
  readActivationSpans,
  readResponseAndSettleTransport,
  startServerSpan,
  WRITE_TOKEN,
  withServer,
} from "./utils.js";

describe("root entry", () => {
  it("dispatches an Express app to the express adapter and exports its SERVER span with the route template", async () => {
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

  it("dispatches a Hono app to the hono adapter and exports its SERVER span with the route template", async () => {
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

  it("delivers spans from a user-constructed provider with ApitallySpanProcessor in its spanProcessors array", async () => {
    const handles = configureAndActivate();
    const userProvider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [new ApitallySpanProcessor()],
    });
    const { span: serverSpan, request } = startServerSpan(
      userProvider.getTracer("user-instrumentation"),
    );
    serverSpan.end();
    handles.spanPipeline.handleTransportCompletion(request.record);

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /items");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
  });

  it("throws an error naming the framework entry points for an unrecognized app", () => {
    prepareFirstRequestActivation();
    const attempt = () => useApitally({} as Hono, { writeToken: WRITE_TOKEN });
    expect(attempt).toThrowError("apitally/express");
    expect(attempt).toThrowError("apitally/hono");
  });
});
