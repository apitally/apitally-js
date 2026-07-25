import { Writable } from "node:stream";
import { diag, type Tracer } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import winston from "winston";
import {
  installConsoleCapture,
  installPinoCapture,
  installWinstonCapture,
  peerResolver,
} from "../../src/logCapture.js";
import { logWarning } from "../../src/logger.js";
import type { SpanPipeline } from "../../src/spanProcessor.js";
import {
  captureStderr,
  createLogPipeline,
  createTracePipeline,
  enableAsyncContextManager,
  runInsideRequest,
} from "../utils.js";

interface CaptureFixture {
  pipeline: SpanPipeline;
  tracer: Tracer;
  loggerProvider: LoggerProvider;
  logExporter: InMemoryLogRecordExporter;
}

function createCaptureFixture(): CaptureFixture {
  enableAsyncContextManager();
  const { pipeline, tracer } = createTracePipeline();
  const { loggerProvider, logExporter } = createLogPipeline(pipeline);
  return { pipeline, tracer, loggerProvider, logExporter };
}

function silenceConsole() {
  return {
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

// winston delivers entries to transports through a stream pipe that completes
// across event-loop turns.
function waitForWinstonDelivery(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createPinoSink(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
  };
}

describe("logCapture", () => {
  describe("console", () => {
    it("captures console calls with per-method severities under the console scope", async () => {
      const fixture = createCaptureFixture();
      const spies = silenceConsole();
      installConsoleCapture(fixture.loggerProvider);
      await runInsideRequest(fixture, () => {
        console.debug("debug message");
        console.log("count: %d", 42);
        console.info("info message");
        console.warn("warn message");
        console.error("error message");
      });
      const records = fixture.logExporter.getFinishedLogRecords();
      expect(
        records.map((record) => [
          record.body,
          record.severityNumber,
          record.severityText,
        ]),
      ).toEqual([
        ["debug message", SeverityNumber.DEBUG, "debug"],
        ["count: 42", SeverityNumber.INFO, "log"],
        ["info message", SeverityNumber.INFO, "info"],
        ["warn message", SeverityNumber.WARN, "warn"],
        ["error message", SeverityNumber.ERROR, "error"],
      ]);
      expect(records.map((record) => record.instrumentationScope.name)).toEqual(
        ["console", "console", "console", "console", "console"],
      );
      expect(spies.log).toHaveBeenCalledWith("count: %d", 42);
    });

    it("never captures SDK diagnostics or OpenTelemetry diagnostic output", async () => {
      const fixture = createCaptureFixture();
      silenceConsole();
      const lines = captureStderr();
      installConsoleCapture(fixture.loggerProvider);
      await runInsideRequest(fixture, () => {
        logWarning("something went wrong in the SDK");
        diag.warn("something went wrong in OpenTelemetry");
        console.info("application log");
      });
      const records = fixture.logExporter.getFinishedLogRecords();
      expect(records.map((record) => record.body)).toEqual(["application log"]);
      expect(lines).toHaveLength(1);
    });

    it("emits captured logs into the private provider only, never a user's global logger provider", async () => {
      const fixture = createCaptureFixture();
      silenceConsole();
      const userExporter = new InMemoryLogRecordExporter();
      logs.setGlobalLoggerProvider(
        new LoggerProvider({
          processors: [
            new SimpleLogRecordProcessor({ exporter: userExporter }),
          ],
        }),
      );
      installConsoleCapture(fixture.loggerProvider);
      await runInsideRequest(fixture, () => {
        console.info("inside request");
      });
      expect(fixture.logExporter.getFinishedLogRecords()).toHaveLength(1);
      expect(userExporter.getFinishedLogRecords()).toHaveLength(0);
    });

    it("captures each console call once after a second install", async () => {
      const fixture = createCaptureFixture();
      silenceConsole();
      installConsoleCapture(fixture.loggerProvider);
      installConsoleCapture(fixture.loggerProvider);
      await runInsideRequest(fixture, () => {
        console.info("logged once");
      });
      expect(fixture.logExporter.getFinishedLogRecords()).toHaveLength(1);
    });
  });

  describe("winston", () => {
    it("captures a logger created before the install through the ensure-attached transport, keeping the logger's own transport working", async () => {
      const fixture = createCaptureFixture();
      const userLines: string[] = [];
      const logger = winston.createLogger({
        transports: [
          new winston.transports.Stream({
            stream: new Writable({
              write: (chunk: Buffer, _encoding, callback) => {
                userLines.push(chunk.toString());
                callback();
              },
            }),
          }),
        ],
      });
      logger.info("before install");
      installWinstonCapture(fixture.loggerProvider);
      await runInsideRequest(fixture, async () => {
        logger.info("inside request");
        await waitForWinstonDelivery();
      });
      const records = fixture.logExporter.getFinishedLogRecords();
      expect(
        records.map((record) => [
          record.body,
          record.severityNumber,
          record.severityText,
        ]),
      ).toEqual([["inside request", SeverityNumber.INFO, "info"]]);
      expect(records.map((record) => record.instrumentationScope.name)).toEqual(
        ["winston"],
      );
      expect(userLines).toHaveLength(2);
    });

    it("respects silent, level thresholds, and dropping or redacting formats", async () => {
      const fixture = createCaptureFixture();
      installWinstonCapture(fixture.loggerProvider);
      const silentLogger = winston.createLogger({ silent: true });
      const warnLogger = winston.createLogger({ level: "warn" });
      const droppingLogger = winston.createLogger({
        format: winston.format(() => false)(),
      });
      const redactingLogger = winston.createLogger({
        format: winston.format((info) => {
          info.message = String(info.message).replace("hunter2", "[hidden]");
          return info;
        })(),
      });
      await runInsideRequest(fixture, async () => {
        silentLogger.info("suppressed by silent");
        warnLogger.info("below the level threshold");
        warnLogger.warn("at the level threshold");
        droppingLogger.info("dropped by the format");
        redactingLogger.info("password hunter2");
        await waitForWinstonDelivery();
      });
      expect(
        fixture.logExporter
          .getFinishedLogRecords()
          .map((record) => record.body),
      ).toEqual(["at the level threshold", "password [hidden]"]);
    });

    it("keeps capturing after clear() removes the transport", async () => {
      const fixture = createCaptureFixture();
      installWinstonCapture(fixture.loggerProvider);
      const logger = winston.createLogger();
      await runInsideRequest(fixture, async () => {
        logger.info("before clear");
        await waitForWinstonDelivery();
        logger.clear();
        logger.info("after clear");
        await waitForWinstonDelivery();
      });
      expect(
        fixture.logExporter
          .getFinishedLogRecords()
          .map((record) => record.body),
      ).toEqual(["before clear", "after clear"]);
    });

    it("captures each entry once after a second install", async () => {
      const fixture = createCaptureFixture();
      installWinstonCapture(fixture.loggerProvider);
      installWinstonCapture(fixture.loggerProvider);
      const logger = winston.createLogger();
      await runInsideRequest(fixture, async () => {
        logger.info("logged once");
        await waitForWinstonDelivery();
      });
      expect(fixture.logExporter.getFinishedLogRecords()).toHaveLength(1);
    });

    it("is a safe no-op when winston is not installed", async () => {
      const fixture = createCaptureFixture();
      vi.spyOn(console, "error").mockImplementation(() => {});
      peerResolver.resolveEntryPath = () => {
        throw new Error("Cannot find module");
      };
      expect(() => installWinstonCapture(fixture.loggerProvider)).not.toThrow();
      const logger = winston.createLogger();
      await runInsideRequest(fixture, async () => {
        logger.info("not captured");
        await waitForWinstonDelivery();
      });
      expect(fixture.logExporter.getFinishedLogRecords()).toHaveLength(0);
    });
  });

  describe("pino", () => {
    it("captures loggers created before and after the install, and their children", async () => {
      const fixture = createCaptureFixture();
      const sink = createPinoSink();
      const createdBefore = pino({}, sink);
      installPinoCapture(fixture.loggerProvider);
      const createdAfter = pino(
        {
          messageKey: "message",
          formatters: { level: (label) => ({ level: label }) },
        },
        sink,
      );
      await runInsideRequest(fixture, () => {
        createdBefore.info("from the logger created before");
        createdBefore
          .child({ module: "billing" })
          .warn("from the child logger");
        createdAfter.error("from the logger created after");
      });
      const records = fixture.logExporter.getFinishedLogRecords();
      expect(
        records.map((record) => [
          record.body,
          record.severityNumber,
          record.severityText,
        ]),
      ).toEqual([
        ["from the logger created before", SeverityNumber.INFO, "info"],
        ["from the child logger", SeverityNumber.WARN, "warn"],
        ["from the logger created after", SeverityNumber.ERROR, "error"],
      ]);
      expect(records.map((record) => record.instrumentationScope.name)).toEqual(
        ["pino", "pino", "pino"],
      );
      expect(sink.lines).toHaveLength(3);
    });

    it("captures downstream of redact paths, serializers, and the user's own streamWrite hook", async () => {
      const fixture = createCaptureFixture();
      installPinoCapture(fixture.loggerProvider);
      const sink = createPinoSink();
      const logger = pino(
        {
          redact: ["password"],
          serializers: { user: (user: { id: number }) => ({ id: user.id }) },
          hooks: { streamWrite: (line) => line.replaceAll("world", "moon") },
        },
        sink,
      );
      const span = await runInsideRequest(fixture, () => {
        logger.info(
          { password: "hunter2", user: { id: 1, email: "jane@example.com" } },
          "hello world",
        );
      });
      const [record] = fixture.logExporter.getFinishedLogRecords();
      expect(record.body).toBe("hello moon");
      expect(record.attributes).toEqual({
        "apitally.request.server_span_id": span.spanContext().spanId,
      });
      expect(sink.lines).toHaveLength(1);
      expect(sink.lines[0]).toContain('"password":"[Redacted]"');
      expect(sink.lines[0]).toContain("hello moon");
      expect(sink.lines[0]).not.toContain("hunter2");
      expect(sink.lines[0]).not.toContain("jane@example.com");
    });

    it("captures each write once after a second install", async () => {
      const fixture = createCaptureFixture();
      installPinoCapture(fixture.loggerProvider);
      installPinoCapture(fixture.loggerProvider);
      const sink = createPinoSink();
      const logger = pino({}, sink);
      await runInsideRequest(fixture, () => {
        logger.info("logged once");
      });
      expect(fixture.logExporter.getFinishedLogRecords()).toHaveLength(1);
      expect(sink.lines).toHaveLength(1);
    });

    it("is a safe no-op when pino is not installed", async () => {
      const fixture = createCaptureFixture();
      peerResolver.resolveEntryPath = () => {
        throw new Error("Cannot find module");
      };
      expect(() => installPinoCapture(fixture.loggerProvider)).not.toThrow();
      const sink = createPinoSink();
      const logger = pino({}, sink);
      await runInsideRequest(fixture, () => {
        logger.info("not captured");
      });
      expect(fixture.logExporter.getFinishedLogRecords()).toHaveLength(0);
      expect(sink.lines).toHaveLength(1);
    });
  });
});
