import { gzipSync } from "node:zlib";
import { SpanKind, trace } from "@opentelemetry/api";
import {
  type Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  type BodyMaskCallback,
  getConfig,
  MAX_BODY_SIZE,
  setConfig,
} from "../../src/config.js";
import { ApitallySpanExporter } from "../../src/exporter.js";
import { Redaction } from "../../src/redaction.js";
import { MAX_STASHED_REQUESTS } from "../../src/spanProcessor.js";
import {
  type DecodedSpan,
  decodedAttributes,
  decodedSpans,
  PROTO_SPAN_KIND_INTERNAL,
  PROTO_SPAN_KIND_SERVER,
} from "../stubOtlpServer.js";
import {
  captureStderr,
  createBatchProcessorOptions,
  createInMemorySpool,
  createTracePipeline,
  readTraceExportFromSpool,
  startServerSpan,
  WRITE_TOKEN,
} from "../utils.js";

function createExportPipeline(
  options: {
    resource?: Resource;
    userExporter?: InMemorySpanExporter;
    env?: string;
  } = {},
) {
  const spool = createInMemorySpool();
  const config = getConfig();
  const spanExporter = new ApitallySpanExporter({
    redaction: new Redaction(),
    env: options.env ?? "prod",
    spool,
    maskRequestBody: config.maskRequestBody,
    maskResponseBody: config.maskResponseBody,
  });
  const downstream = new BatchSpanProcessor(
    spanExporter,
    createBatchProcessorOptions(),
  );
  const { pipeline, provider, tracer } = createTracePipeline({
    downstream,
    extraSpanProcessors: options.userExporter
      ? [new SimpleSpanProcessor(options.userExporter)]
      : [],
    resource: options.resource,
  });
  return { pipeline, provider, tracer, spool };
}

function attributesOfSpan(
  spans: DecodedSpan[],
  name: string,
): Record<string, unknown> {
  const span = spans.find((candidate) => candidate.name === name);
  if (!span) {
    throw new Error(`No exported span named ${name}`);
  }
  return decodedAttributes(span.attributes);
}

describe("exporter", () => {
  it("redacts query and captured header attributes in both semconv normalizations on every span, leaving the original untouched", async () => {
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const { span, request } = startServerSpan(tracer, {
      attributes: {
        "url.query": "token=secret123&page=2",
        "http.target": "/items?token=secret123&page=2",
        "http.url": "https://example.com/items?token=secret123&page=2",
        "http.request.header.authorization": ["Bearer secret123"],
        "http.response.header.set-cookie": ["session=abc"],
        "http.response.header.content-type": ["application/json"],
        "http.response.header.location": ["/next?token=secret123&page=2"],
      },
    });
    tracer
      .startSpan(
        "GET",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "url.full": "https://x.example/v1?api-key=secret&ok=1",
          },
        },
        trace.setSpan(request.context, span),
      )
      .end();
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(spans).toHaveLength(2);
    const clientAttributes = attributesOfSpan(spans, "GET");
    expect(clientAttributes["url.full"]).toBe(
      "https://x.example/v1?api-key=%5BREDACTED%5D&ok=1",
    );
    const serverAttributes = attributesOfSpan(spans, "GET /items");
    expect(serverAttributes["url.query"]).toBe("token=%5BREDACTED%5D&page=2");
    expect(serverAttributes["http.target"]).toBe(
      "/items?token=%5BREDACTED%5D&page=2",
    );
    expect(serverAttributes["http.url"]).toBe(
      "https://example.com/items?token=%5BREDACTED%5D&page=2",
    );
    expect(serverAttributes["http.request.header.authorization"]).toEqual([
      "[REDACTED]",
    ]);
    expect(serverAttributes["http.response.header.set-cookie"]).toEqual([
      "[REDACTED]",
    ]);
    expect(serverAttributes["http.response.header.content-type"]).toEqual([
      "application/json",
    ]);
    expect(serverAttributes["http.response.header.location"]).toEqual([
      "/next?token=%5BREDACTED%5D&page=2",
    ]);
    expect(span.attributes["url.query"]).toBe("token=secret123&page=2");
    expect(span.attributes["http.request.header.authorization"]).toEqual([
      "Bearer secret123",
    ]);
  });

  it("applies the request record onto the export copy last, so late-learned transport values win", async () => {
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const { span, request } = startServerSpan(tracer, {
      attributes: { "http.route": "/raw-path", "url.path": "/items/42" },
    });
    span.end();
    request.record.attributes["http.route"] = "/items/{id}";
    request.record.attributes["http.response.body.size"] = 45;
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    const attributes = attributesOfSpan(spans, "GET /items");
    expect(attributes["http.route"]).toBe("/items/{id}");
    expect(attributes["http.response.body.size"]).toBe(45);
    expect(span.attributes["http.route"]).toBe("/raw-path");
  });

  it("keeps captured headers and bodies off the live span and out of user exporters", async () => {
    setConfig({ writeToken: WRITE_TOKEN });
    const userExporter = new InMemorySpanExporter();
    const { pipeline, provider, tracer, spool } = createExportPipeline({
      userExporter,
    });
    const { span, request } = startServerSpan(tracer, { name: "POST /items" });
    pipeline.updateStash(span.spanContext().spanId, {
      requestHeaders: {
        authorization: ["Bearer secret123"],
        accept: ["application/json"],
      },
      requestBody: Buffer.from('{"password": "hunter2"}'),
      responseHeaders: {
        "set-cookie": ["session=abc123"],
        "content-type": ["application/json"],
      },
      responseBody: Buffer.from('{"token": "xyz", "id": 7}'),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    const attributes = attributesOfSpan(spans, "POST /items");
    expect(attributes["apitally.request.body"]).toBe(
      '{"password":"[REDACTED]"}',
    );
    expect(attributes["apitally.response.body"]).toBe(
      '{"token":"[REDACTED]","id":7}',
    );
    expect(attributes["http.request.header.authorization"]).toEqual([
      "[REDACTED]",
    ]);
    expect(attributes["http.request.header.accept"]).toEqual([
      "application/json",
    ]);
    expect(attributes["http.response.header.set-cookie"]).toEqual([
      "[REDACTED]",
    ]);
    expect(attributes["http.response.header.content-type"]).toEqual([
      "application/json",
    ]);
    expect(span.attributes).toEqual({});
    const [userSpan] = userExporter.getFinishedSpans();
    expect(userSpan.attributes).toEqual({});
    expect("apitallyData" in userSpan).toBe(false);
  });

  it("exports a nested SERVER span as INTERNAL on Apitally's copy and warns once naming the producing scope", async () => {
    const userExporter = new InMemorySpanExporter();
    const { pipeline, provider, tracer, spool } = createExportPipeline({
      userExporter,
    });
    const lines = captureStderr();
    const producingTracer = provider.getTracer("@hono/otel");
    for (const index of [1, 2]) {
      const { span, request } = startServerSpan(tracer, {
        name: `GET /items ${index}`,
      });
      producingTracer
        .startSpan(
          `duplicate ${index}`,
          { kind: SpanKind.SERVER },
          trace.setSpan(request.context, span),
        )
        .end();
      span.end();
      pipeline.handleTransportCompletion(request.record);
    }

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(spans).toHaveLength(4);
    expect(spans.find((span) => span.name === "duplicate 1")?.kind).toBe(
      PROTO_SPAN_KIND_INTERNAL,
    );
    expect(spans.find((span) => span.name === "GET /items 1")?.kind).toBe(
      PROTO_SPAN_KIND_SERVER,
    );
    const userDuplicate = userExporter
      .getFinishedSpans()
      .find((span) => span.name === "duplicate 1");
    expect(userDuplicate?.kind).toBe(SpanKind.SERVER);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("@hono/otel");
  });

  it("exports a nested SERVER span that ends after its request released as INTERNAL on Apitally's copy", async () => {
    const userExporter = new InMemorySpanExporter();
    const { pipeline, provider, tracer, spool } = createExportPipeline({
      userExporter,
    });
    captureStderr();
    const producingTracer = provider.getTracer("@hono/otel");
    const { span, request } = startServerSpan(tracer, { name: "GET /items" });
    const duplicate = producingTracer.startSpan(
      "duplicate",
      { kind: SpanKind.SERVER },
      trace.setSpan(request.context, span),
    );
    span.end();
    pipeline.handleTransportCompletion(request.record);
    duplicate.end();

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(spans).toHaveLength(2);
    expect(spans.find((span) => span.name === "duplicate")?.kind).toBe(
      PROTO_SPAN_KIND_INTERNAL,
    );
    expect(spans.find((span) => span.name === "GET /items")?.kind).toBe(
      PROTO_SPAN_KIND_SERVER,
    );
    const userDuplicate = userExporter
      .getFinishedSpans()
      .find((span) => span.name === "duplicate");
    expect(userDuplicate?.kind).toBe(SpanKind.SERVER);
  });

  it("rewrites a differing deployment environment resource attribute to the resolved env on Apitally's copies only, warning once", async () => {
    const resource = resourceFromAttributes({
      "deployment.environment.name": "staging",
      "service.name": "user-service",
    });
    const userExporter = new InMemorySpanExporter();
    const { pipeline, provider, tracer, spool } = createExportPipeline({
      resource,
      userExporter,
      env: "prod",
    });
    const lines = captureStderr();
    const { span, request } = startServerSpan(tracer);
    tracer.startSpan("child", {}, trace.setSpan(request.context, span)).end();
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const exported = await readTraceExportFromSpool(provider, spool);
    // One resourceSpans group: the rewritten resource is shared across the batch
    expect(exported.resourceSpans).toHaveLength(1);
    const resourceAttributes = decodedAttributes(
      exported.resourceSpans[0].resource?.attributes ?? [],
    );
    expect(resourceAttributes["deployment.environment.name"]).toBe("prod");
    expect(resourceAttributes["service.name"]).toBe("user-service");
    expect(decodedSpans(exported)).toHaveLength(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("staging");
    const [userSpan] = userExporter.getFinishedSpans();
    expect(userSpan.resource.attributes["deployment.environment.name"]).toBe(
      "staging",
    );
  });

  it("fills in the deployment environment resource attribute on Apitally's copies when the tracer provider's resource omits it", async () => {
    const resource = resourceFromAttributes({
      "service.name": "user-service",
    });
    const userExporter = new InMemorySpanExporter();
    const { pipeline, provider, tracer, spool } = createExportPipeline({
      resource,
      userExporter,
      env: "staging",
    });
    const lines = captureStderr();
    const { span, request } = startServerSpan(tracer);
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const exported = await readTraceExportFromSpool(provider, spool);
    expect(exported.resourceSpans).toHaveLength(1);
    const resourceAttributes = decodedAttributes(
      exported.resourceSpans[0].resource?.attributes ?? [],
    );
    expect(resourceAttributes["deployment.environment.name"]).toBe("staging");
    expect(resourceAttributes["service.name"]).toBe("user-service");
    expect(lines).toEqual([]);
    const [userSpan] = userExporter.getFinishedSpans();
    expect(
      userSpan.resource.attributes["deployment.environment.name"],
    ).toBeUndefined();
  });

  it("replaces the body with [REDACTED] without a warning when the mask callback returns null or undefined", async () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      maskRequestBody: () => null,
      maskResponseBody: (() => undefined) as unknown as BodyMaskCallback,
    });
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const lines = captureStderr();
    const { span, request } = startServerSpan(tracer);
    pipeline.updateStash(span.spanContext().spanId, {
      requestBody: Buffer.from('{"a": 1}'),
      responseBody: Buffer.from('{"b": 2}'),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    const attributes = attributesOfSpan(spans, "GET /items");
    expect(attributes["apitally.request.body"]).toBe("[REDACTED]");
    expect(attributes["apitally.response.body"]).toBe("[REDACTED]");
    expect(lines).toHaveLength(0);
  });

  it("replaces the body with [REDACTED] and warns once per process when the mask callback throws", async () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      maskRequestBody: () => {
        throw new Error("mask failed");
      },
    });
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const lines = captureStderr();
    for (const name of ["POST /first", "POST /second"]) {
      const { span, request } = startServerSpan(tracer, { name });
      pipeline.updateStash(span.spanContext().spanId, {
        requestBody: Buffer.from('{"a": 1}'),
      });
      span.end();
      pipeline.handleTransportCompletion(request.record);
    }

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(
      attributesOfSpan(spans, "POST /first")["apitally.request.body"],
    ).toBe("[REDACTED]");
    expect(
      attributesOfSpan(spans, "POST /second")["apitally.request.body"],
    ).toBe("[REDACTED]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("maskRequestBody");
  });

  it("replaces the body with [REDACTED] and warns when the mask callback returns a Promise", async () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      maskResponseBody: (async (body: Buffer) =>
        body) as unknown as BodyMaskCallback,
    });
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const lines = captureStderr();
    const { span, request } = startServerSpan(tracer);
    pipeline.updateStash(span.spanContext().spanId, {
      responseBody: Buffer.from('{"b": 2}'),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(
      attributesOfSpan(spans, "GET /items")["apitally.response.body"],
    ).toBe("[REDACTED]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("maskResponseBody");
  });

  it("replaces the body with [BODY_TOO_LARGE] when the masked result exceeds the size cap", async () => {
    setConfig({
      writeToken: WRITE_TOKEN,
      maskRequestBody: () => Buffer.alloc(MAX_BODY_SIZE + 1, "a"),
    });
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const { span, request } = startServerSpan(tracer);
    pipeline.updateStash(span.spanContext().spanId, {
      requestBody: Buffer.from('{"a": 1}'),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(attributesOfSpan(spans, "GET /items")["apitally.request.body"]).toBe(
      "[BODY_TOO_LARGE]",
    );
  });

  it("runs the mask callback on the raw body before parsing, field redaction, and serialization", async () => {
    const seen: { body: Buffer; ended: boolean; attributes: unknown }[] = [];
    setConfig({
      writeToken: WRITE_TOKEN,
      maskRequestBody: (body, span) => {
        seen.push({ body, ended: span.ended, attributes: span.attributes });
        return Buffer.from('{"a": 2, "password": "hunter2"}');
      },
    });
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const { span, request } = startServerSpan(tracer);
    pipeline.updateStash(span.spanContext().spanId, {
      requestHeaders: {
        authorization: ["Bearer secret123"],
        "content-type": ["application/json"],
      },
      requestBody: Buffer.from('{"a": 1}'),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(attributesOfSpan(spans, "GET /items")["apitally.request.body"]).toBe(
      '{"a":2,"password":"[REDACTED]"}',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].body.toString()).toBe('{"a": 1}');
    expect(seen[0].ended).toBe(true);
    // The callback sees the span as it will be exported, minus the body attributes
    expect(seen[0].attributes).toEqual({
      "http.request.header.authorization": ["[REDACTED]"],
      "http.request.header.content-type": ["application/json"],
    });
  });

  it("exports a stashed [BODY_TOO_LARGE] sentinel unchanged without invoking the mask callback", async () => {
    const maskCalls: Buffer[] = [];
    setConfig({
      writeToken: WRITE_TOKEN,
      maskRequestBody: (body) => {
        maskCalls.push(body);
        return body;
      },
    });
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const { span, request } = startServerSpan(tracer);
    pipeline.updateStash(span.spanContext().spanId, {
      requestBody: Buffer.from("[BODY_TOO_LARGE]"),
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(attributesOfSpan(spans, "GET /items")["apitally.request.body"]).toBe(
      "[BODY_TOO_LARGE]",
    );
    expect(maskCalls).toHaveLength(0);
  });

  it("passes a pre-compressed response body through as bytes without decompression", async () => {
    const compressed = gzipSync('{"password": "hunter2"}');
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const { span, request } = startServerSpan(tracer);
    pipeline.updateStash(span.spanContext().spanId, {
      responseBody: compressed,
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    const body = attributesOfSpan(spans, "GET /items")[
      "apitally.response.body"
    ];
    expect(Buffer.from(body as Uint8Array).equals(compressed)).toBe(true);
  });

  it("drops a span whose export processing fails instead of exporting it raw", async () => {
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const { span, request } = startServerSpan(tracer);
    tracer.startSpan("child", {}, trace.setSpan(request.context, span)).end();
    const poisonedHeaders: Record<string, string[]> = {
      accept: ["application/json"],
    };
    Object.defineProperty(poisonedHeaders, "cookie", {
      enumerable: true,
      get() {
        throw new Error("poisoned header");
      },
    });
    pipeline.updateStash(span.spanContext().spanId, {
      requestHeaders: poisonedHeaders,
    });
    span.end();
    const lines = captureStderr();
    pipeline.handleTransportCompletion(request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(spans.map((span) => span.name)).toEqual(["child"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("dropped");
  });

  it("evicts the oldest stashed payloads when the process-wide cap is reached", async () => {
    const { pipeline, provider, tracer, spool } = createExportPipeline();
    const first = startServerSpan(tracer, { name: "GET /first" });
    pipeline.updateStash(first.span.spanContext().spanId, {
      requestBody: Buffer.from('{"n": 1}'),
    });
    for (let index = 0; index < MAX_STASHED_REQUESTS - 1; index++) {
      const filler = startServerSpan(tracer);
      pipeline.updateStash(filler.span.spanContext().spanId, {
        requestBody: Buffer.from("{}"),
      });
    }
    const last = startServerSpan(tracer, { name: "GET /last" });
    pipeline.updateStash(last.span.spanContext().spanId, {
      requestBody: Buffer.from('{"n": 2}'),
    });
    first.span.end();
    pipeline.handleTransportCompletion(first.request.record);
    last.span.end();
    pipeline.handleTransportCompletion(last.request.record);

    const spans = decodedSpans(await readTraceExportFromSpool(provider, spool));
    expect(spans).toHaveLength(2);
    expect(
      attributesOfSpan(spans, "GET /first")["apitally.request.body"],
    ).toBeUndefined();
    expect(attributesOfSpan(spans, "GET /last")["apitally.request.body"]).toBe(
      '{"n":2}',
    );
  });
});
