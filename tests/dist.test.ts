import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type DecodedLogRecord,
  type DecodedMetric,
  type DecodedSpan,
  decodedAttributes,
  decodedLogRecords,
  decodedMetrics,
  decodedSpans,
  decodeLogsExport,
  decodeMetricsExport,
  decodeTraceExport,
  durationDataPoints,
  PROTO_SPAN_KIND_SERVER,
} from "./stubOtlpServer.js";
import { UNROUTABLE_ENDPOINT, WRITE_TOKEN } from "./utils.js";

const CHILD_TIMEOUT_MILLIS = 60_000;
const TEST_OPTIONS = { timeout: 90_000 };

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

interface DistChildResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// Spawns a plain-JS child fixture that loads the built package by
// self-reference. The environment is constructed explicitly so no test-runner
// markers leak into the child and activation runs for real.
async function runDistChild(
  fixtureFileName: string,
  env: Record<string, string> = {},
): Promise<DistChildResult> {
  const child = spawn(
    process.execPath,
    [join(repoRoot, "tests", fixtureFileName)],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        APITALLY_WRITE_TOKEN: WRITE_TOKEN,
        APITALLY_OTLP_ENDPOINT: UNROUTABLE_ENDPOINT,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CHILD_TIMEOUT_MILLIS,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [exitCode] = (await once(child, "close")) as [number | null];
  return { exitCode, stdout, stderr };
}

function childSummary<Summary>(result: DistChildResult): Summary {
  const lines = result.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as Summary;
}

interface SinkExports {
  spans: DecodedSpan[];
  traceScopeNames: string[];
  logRecords: DecodedLogRecord[];
  metrics: DecodedMetric[];
}

// Decodes everything the child's OTLP sink received, across all files and
// signals, with the same protobuf helpers the in-process export tests use.
async function readSinkExports(sinkDir: string): Promise<SinkExports> {
  const exports: SinkExports = {
    spans: [],
    traceScopeNames: [],
    logRecords: [],
    metrics: [],
  };
  for (const name of (await readdir(sinkDir)).sort()) {
    const body = await readFile(join(sinkDir, name));
    if (name.startsWith("traces-")) {
      const traceRequest = decodeTraceExport(body);
      exports.spans.push(...decodedSpans(traceRequest));
      exports.traceScopeNames.push(
        ...traceRequest.resourceSpans.flatMap((resourceSpans) =>
          resourceSpans.scopeSpans.map(
            (scopeSpans) => scopeSpans.scope?.name ?? "",
          ),
        ),
      );
    } else if (name.startsWith("logs-")) {
      exports.logRecords.push(...decodedLogRecords(decodeLogsExport(body)));
    } else if (name.startsWith("metrics-")) {
      exports.metrics.push(...decodedMetrics(decodeMetricsExport(body)));
    }
  }
  return exports;
}

async function createSinkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "apitally-dist-"));
}

describe("built package", () => {
  it.each(["esm", "cjs"])(
    "exports one SERVER span, one startup event, and the winston and pino logs when one app is wrapped through both build entries with the %s entry first",
    TEST_OPTIONS,
    async (firstEntry) => {
      const sinkDir = await createSinkDir();
      const result = await runDistChild("distApp.mjs", {
        DIST_SINK_DIR: sinkDir,
        DIST_WRAP_ORDER: firstEntry,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("[Apitally");
      expect(childSummary(result)).toEqual({
        status: 200,
        body: { ok: true },
      });

      const { spans, logRecords, metrics } = await readSinkExports(sinkDir);
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("GET /items/:id");
      expect(spans[0].kind).toBe(PROTO_SPAN_KIND_SERVER);
      expect(decodedAttributes(spans[0].attributes)["http.route"]).toBe(
        "/items/:id",
      );

      const startupRecords = logRecords.filter(
        (record) => record.eventName === "apitally.app.startup",
      );
      expect(startupRecords).toHaveLength(1);
      const appLogRecords = logRecords.filter(
        (record) => record.eventName !== "apitally.app.startup",
      );
      expect(
        appLogRecords.map((record) => record.body?.stringValue).sort(),
      ).toEqual(["pino message", "winston message"]);
      const serverSpanId = Buffer.from(spans[0].spanId ?? []).toString("hex");
      for (const record of appLogRecords) {
        expect(
          decodedAttributes(record.attributes)[
            "apitally.request.server_span_id"
          ],
        ).toBe(serverSpanId);
      }

      const dataPoints = durationDataPoints(metrics);
      expect(dataPoints).toHaveLength(1);
      expect(dataPoints[0].count).toBe(1);
      expect(decodedAttributes(dataPoints[0].attributes)).toEqual({
        "http.request.method": "GET",
        "http.route": "/items/:id",
        "http.response.status_code": 200,
        "url.scheme": "http",
      });
    },
  );

  it(
    "adopts the user's SERVER spans on an existing NodeSDK setup, dropping the pre-activation first request from traces while metrics count both requests",
    TEST_OPTIONS,
    async () => {
      const sinkDir = await createSinkDir();
      const result = await runDistChild("distAdoptedApp.mjs", {
        DIST_SINK_DIR: sinkDir,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const summary = childSummary<{
        serverSpans: { kind: number; path: string; spanId: string }[];
      }>(result);
      expect(summary.serverSpans.map((span) => span.path)).toEqual([
        "/adopted/1",
        "/adopted/2",
      ]);

      const { spans, traceScopeNames, logRecords, metrics } =
        await readSinkExports(sinkDir);
      expect(spans).toHaveLength(1);
      expect(spans[0].kind).toBe(PROTO_SPAN_KIND_SERVER);
      expect(Buffer.from(spans[0].spanId ?? []).toString("hex")).toBe(
        summary.serverSpans[1].spanId,
      );
      expect(traceScopeNames).toEqual(["@opentelemetry/instrumentation-http"]);
      const attributes = decodedAttributes(spans[0].attributes);
      expect(attributes["http.route"]).toBe("/adopted/:id");
      expect(attributes["http.response.status_code"]).toBe(200);

      expect(logRecords).toHaveLength(1);
      expect(logRecords[0].eventName).toBe("apitally.app.startup");

      const dataPoints = durationDataPoints(metrics);
      expect(dataPoints).toHaveLength(1);
      expect(dataPoints[0].count).toBe(2);
      expect(decodedAttributes(dataPoints[0].attributes)).toEqual({
        "http.request.method": "GET",
        "http.route": "/adopted/:id",
        "http.response.status_code": 200,
        "url.scheme": "http",
      });
    },
  );

  it(
    "exports the full route template including the mount prefix for routes registered at module scope behind the register entry",
    TEST_OPTIONS,
    async () => {
      const sinkDir = await createSinkDir();
      const result = await runDistChild("distRegisterApp.mjs", {
        DIST_SINK_DIR: sinkDir,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("[Apitally");
      expect(childSummary(result)).toEqual({ status: 200 });

      const { spans } = await readSinkExports(sinkDir);
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("GET /api/items/:id");
      expect(spans[0].kind).toBe(PROTO_SPAN_KIND_SERVER);
      expect(decodedAttributes(spans[0].attributes)["http.route"]).toBe(
        "/api/items/:id",
      );
    },
  );

  it(
    "exits on its own after serving a request and closing the server",
    TEST_OPTIONS,
    async () => {
      const result = await runDistChild("distLivenessApp.mjs");
      expect(result.exitCode, result.stderr).toBe(0);
      expect(childSummary(result)).toEqual({ status: 200 });
    },
  );
});
