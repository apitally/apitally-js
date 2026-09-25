import { context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import {
  emitConsumerUpdateIfChanged,
  MAX_CACHED_CONSUMERS,
  setConsumer,
} from "../src/consumers.js";
import {
  configureAndActivate,
  createTracePipeline,
  enableAsyncContextManager,
  readSerializedLogRecords,
  requireActivationHandles,
  startServerSpan,
} from "./utils.js";

describe("consumers", () => {
  it("writes the trimmed and capped identifier to the SERVER span and request record", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      setConsumer({ identifier: `  ${"i".repeat(200)}  ` });
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["apitally.consumer.identifier"]).toBe("i".repeat(128));
    expect(request.record.attributes["apitally.consumer.identifier"]).toBe("i".repeat(128));
  });

  it("converts a runtime numeric identifier to a string", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    const { span, request } = startServerSpan(tracer);
    context.with(trace.setSpan(request.context, span), () => {
      setConsumer(123 as unknown as string);
    });
    span.end();
    pipeline.handleTransportCompletion(request.record);
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes["apitally.consumer.identifier"]).toBe("123");
  });

  it("produces no consumer attributes for a missing, empty, or invalid identifier", () => {
    enableAsyncContextManager();
    const { pipeline, tracer, exporter } = createTracePipeline();
    for (const consumer of ["", "   ", {} as never, { identifier: "  " } as never]) {
      const { span, request } = startServerSpan(tracer);
      context.with(trace.setSpan(request.context, span), () => {
        setConsumer(consumer);
      });
      span.end();
      pipeline.handleTransportCompletion(request.record);
      expect(request.record.consumer).toBeUndefined();
    }
    for (const span of exporter.getFinishedSpans()) {
      expect(span.attributes["apitally.consumer.identifier"]).toBeUndefined();
    }
  });

  it("emits trimmed and capped consumer metadata as a root-context consumer update event", async () => {
    configureAndActivate();
    completeRequestWithConsumers({
      identifier: "  acme  ",
      name: `  ${"n".repeat(100)}  `,
      group: `  ${"g".repeat(100)}  `,
    });

    const records = await readConsumerUpdateRecords();
    expect(records).toHaveLength(1);
    expect(records[0].eventName).toBe("apitally.consumer.update");
    expect(records[0].instrumentationScope.name).toBe("apitally");
    expect(records[0].spanContext).toBeUndefined();
    expect(records[0].attributes).toEqual({});
    expect(records[0].body).toEqual({
      identifier: "acme",
      name: "n".repeat(64),
      group: "g".repeat(64),
    });
  });

  it("normalizes attributes and keeps the first 10 valid entries", async () => {
    configureAndActivate();
    completeRequestWithConsumers({
      identifier: "acme",
      attributes: {
        "  plan  ": "  pro  ",
        seats: 5,
        ratio: 1.5,
        trial: false,
        region: null,
        note: "   ",
        skipped: undefined,
        "   ": "empty key",
        ["k".repeat(65)]: "long key",
        long: "v".repeat(1025),
        max: "v".repeat(1024),
        list: ["a"] as never,
        object: {} as never,
        extra1: "1",
        extra2: "2",
        extra3: "3",
        extra4: "4",
      },
    });

    const records = await readConsumerUpdateRecords();
    expect(records.map((record) => record.body)).toEqual([
      {
        identifier: "acme",
        attributes: {
          plan: "pro",
          seats: "5",
          ratio: "1.5",
          trial: "false",
          region: null,
          note: null,
          max: "v".repeat(1024),
          extra1: "1",
          extra2: "2",
          extra3: "3",
        },
      },
    ]);
  });

  it("merges calls for the same identifier and resets for a different identifier", async () => {
    configureAndActivate();
    completeRequestWithConsumers(
      { identifier: "acme", name: "Acme", attributes: { plan: "free", seats: 1 } },
      { identifier: "acme", group: "enterprise", attributes: { plan: "pro", region: "eu" } },
    );
    completeRequestWithConsumers(
      { identifier: "acme", name: "Acme", attributes: { plan: "pro" } },
      { identifier: "globex", attributes: { region: "us" } },
    );

    const records = await readConsumerUpdateRecords();
    expect(records.map((record) => record.body)).toEqual([
      {
        identifier: "acme",
        name: "Acme",
        group: "enterprise",
        attributes: { plan: "pro", seats: "1", region: "eu" },
      },
      { identifier: "globex", attributes: { region: "us" } },
    ]);
  });

  it("emits no consumer update without name, group, or attributes", async () => {
    configureAndActivate();
    completeRequestWithConsumers("acme");
    completeRequestWithConsumers({ identifier: "acme", name: "  ", attributes: { a: undefined } });

    expect(await readConsumerUpdateRecords()).toEqual([]);
  });

  it("emits a consumer update only when the name, group, or attributes change", async () => {
    configureAndActivate();
    completeRequestWithConsumers({ identifier: "acme", attributes: { plan: "pro", seats: 5 } });
    completeRequestWithConsumers({ identifier: "acme", attributes: { seats: "5", plan: "pro" } });
    completeRequestWithConsumers({ identifier: "acme", attributes: { plan: "pro", seats: 6 } });

    const records = await readConsumerUpdateRecords();
    expect(records.map((record) => record.body)).toEqual([
      { identifier: "acme", attributes: { plan: "pro", seats: "5" } },
      { identifier: "acme", attributes: { plan: "pro", seats: "6" } },
    ]);
  });

  it("evicts the least recently used consumer when the cache is full", async () => {
    const handles = configureAndActivate();
    const complete = (identifier: string) =>
      completeRequestWithConsumers({ identifier, name: "Name" });
    complete("a");
    complete("b");
    for (let index = 0; index < MAX_CACHED_CONSUMERS - 2; index++) {
      handles.consumerUpdateHashes.set(`synthetic-${index}`, "");
    }
    complete("a");
    complete("c");
    complete("a");
    complete("b");

    const records = await readConsumerUpdateRecords();
    expect(records.map((record) => (record.body as { identifier: string }).identifier)).toEqual([
      "a",
      "b",
      "c",
      "b",
    ]);
  });

  it("is a safe no-op outside a request", () => {
    const { exporter } = createTracePipeline();
    expect(() => setConsumer("tenant-1")).not.toThrow();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

function completeRequestWithConsumers(...consumers: Parameters<typeof setConsumer>[0][]): void {
  const { span, request } = startServerSpan(trace.getTracer("test"));
  context.with(trace.setSpan(request.context, span), () => {
    for (const consumer of consumers) {
      setConsumer(consumer);
    }
    emitConsumerUpdateIfChanged(request.record);
  });
  span.end();
}

async function readConsumerUpdateRecords() {
  await requireActivationHandles().loggerProvider.forceFlush();
  return readSerializedLogRecords();
}
