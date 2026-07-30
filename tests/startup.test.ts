import { context, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { describe, expect, it } from "vitest";
import { setConfig } from "../src/config.js";
import { emitStartupEvent } from "../src/startup.js";
import { enableAsyncContextManager, WRITE_TOKEN } from "./utils.js";

const PATHS = [
  { method: "GET", path: "/users" },
  { method: "POST", path: "/users" },
];

function createLoggerProvider(): {
  loggerProvider: LoggerProvider;
  logExporter: InMemoryLogRecordExporter;
} {
  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });
  return { loggerProvider, logExporter };
}

describe("startup", () => {
  it("emits the startup event once under the apitally scope with the JSON payload", () => {
    setConfig({ writeToken: WRITE_TOKEN, appVersion: "2.3.1" });
    const { loggerProvider, logExporter } = createLoggerProvider();
    let pathsResolvedCount = 0;
    const info = {
      framework: "express",
      frameworkVersion: "5.1.0",
      resolvePaths: () => {
        pathsResolvedCount++;
        return PATHS;
      },
    };
    emitStartupEvent(loggerProvider, info);
    emitStartupEvent(loggerProvider, info);

    const [record] = logExporter.getFinishedLogRecords();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(1);
    expect(pathsResolvedCount).toBe(1);
    expect(record.instrumentationScope.name).toBe("apitally");
    expect(record.hrTime[0]).toBeGreaterThan(0);
    expect(typeof record.body).toBe("string");
    expect(JSON.parse(record.body as string)).toEqual({
      framework: "express",
      versions: {
        node: process.versions.node,
        express: "5.1.0",
        app: "2.3.1",
      },
      paths: PATHS,
    });
  });

  it("normalizes, filters, and deduplicates paths in first-seen order", () => {
    const { loggerProvider, logExporter } = createLoggerProvider();
    emitStartupEvent(loggerProvider, {
      framework: "hono",
      resolvePaths: () => [
        { method: "get", path: "/items" },
        { method: "ALL", path: "/items" },
        { method: "GET", path: "/items" },
        { method: "post", path: "/items" },
        { method: "head", path: "/items" },
        { method: "options", path: "/items" },
      ],
    });

    const [record] = logExporter.getFinishedLogRecords();
    expect(JSON.parse(record.body as string).paths).toEqual([
      { method: "GET", path: "/items" },
      { method: "POST", path: "/items" },
    ]);
  });

  it("sets the event name natively on the emitted record, not as an attribute", () => {
    const { loggerProvider, logExporter } = createLoggerProvider();
    emitStartupEvent(loggerProvider, {
      framework: "hono",
      resolvePaths: () => PATHS,
    });

    const [record] = logExporter.getFinishedLogRecords();
    expect(record.eventName).toBe("apitally.app.startup");
    expect(record.attributes).toEqual({});
  });

  it("keeps trace context off the record when emitted inside an active span", () => {
    enableAsyncContextManager();
    const { loggerProvider, logExporter } = createLoggerProvider();
    const activeSpanContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
    });
    context.with(activeSpanContext, () => {
      emitStartupEvent(loggerProvider, {
        framework: "express",
        resolvePaths: () => PATHS,
      });
    });

    const [record] = logExporter.getFinishedLogRecords();
    expect(record.spanContext).toBeUndefined();
  });

  it("emits the versions without paths when the paths supplier throws", () => {
    const { loggerProvider, logExporter } = createLoggerProvider();
    emitStartupEvent(loggerProvider, {
      framework: "express",
      frameworkVersion: "4.21.2",
      resolvePaths: () => {
        throw new Error("routes not ready");
      },
    });

    const [record] = logExporter.getFinishedLogRecords();
    expect(JSON.parse(record.body as string)).toEqual({
      framework: "express",
      versions: { node: process.versions.node, express: "4.21.2" },
    });
  });

  it("emits the versions without paths when the paths are unserializable", () => {
    const { loggerProvider, logExporter } = createLoggerProvider();
    emitStartupEvent(loggerProvider, {
      framework: "express",
      resolvePaths: () => [
        { method: "GET", path: "/big", size: 1n } as unknown as {
          method: string;
          path: string;
        },
      ],
    });

    const [record] = logExporter.getFinishedLogRecords();
    expect(JSON.parse(record.body as string)).toEqual({
      framework: "express",
      versions: { node: process.versions.node },
    });
  });
});
