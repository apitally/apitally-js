import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { context } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExportWorker,
  type ExportWorkerOptions,
  MAX_SENDS_PER_CYCLE,
} from "../../src/exportWorker.js";
import {
  MAX_RETRY_TIME_AFTER_FIRST_ATTEMPT_MILLIS,
  Spool,
} from "../../src/spool.js";
import {
  decodeLogsExport,
  decodeMetricsExport,
  decodeTraceExport,
  StubOtlpServer,
  spanNames,
} from "../stubOtlpServer.js";
import {
  buildLogsPayload,
  buildMetricsPayload,
  buildTracePayload,
  captureStderr,
  enableAsyncContextManager,
  readPackageVersion,
  WRITE_TOKEN,
} from "../utils.js";

function findUnusedPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe("exportWorker", () => {
  let tempDir: string;
  let spool: Spool;
  let server: StubOtlpServer;
  let worker: ExportWorker | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "apitally-test-"));
    spool = new Spool(tempDir);
    server = await StubOtlpServer.start();
  });

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await server.close();
    await spool.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  function createWorker(
    overrides: Partial<ExportWorkerOptions> = {},
  ): ExportWorker {
    worker = new ExportWorker({
      spool,
      otlpEndpoint: server.url,
      writeToken: WRITE_TOKEN,
      env: "dev",
      requestTimeoutMillis: 2_000,
      interSendPauseMillis: () => 0,
      ...overrides,
    });
    return worker;
  }

  async function appendClosedTraceFiles(count: number): Promise<string[]> {
    const names: string[] = [];
    for (let index = 0; index < count; index++) {
      const name = `GET /${index}`;
      names.push(name);
      await spool.append("traces", buildTracePayload(name));
      await spool.closeCurrentFiles();
    }
    return names;
  }

  it("posts all three signals with export headers in one cycle", async () => {
    const worker = createWorker();
    const tracePayload = buildTracePayload("GET /items");
    const logsPayload = buildLogsPayload("something happened");
    const metricsPayload = await buildMetricsPayload("app.things");
    await spool.append("traces", tracePayload);
    await spool.append("logs", logsPayload);
    await spool.append("metrics", metricsPayload);
    await worker.runCycle();
    expect(server.paths()).toEqual(["/v1/traces", "/v1/logs", "/v1/metrics"]);
    const version = readPackageVersion();
    for (const request of server.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${WRITE_TOKEN}`);
      expect(request.headers["apitally-env"]).toBe("dev");
      expect(request.headers["content-type"]).toBe("application/x-protobuf");
      expect(request.headers["content-encoding"]).toBe("gzip");
      expect(request.headers["user-agent"]).toBe(`apitally-js/${version}`);
    }
    const [traceRequest, logsRequest, metricsRequest] = server.requests;
    expect(gunzipSync(traceRequest.body)).toEqual(Buffer.from(tracePayload));
    expect(spanNames(decodeTraceExport(traceRequest.body))).toEqual([
      "GET /items",
    ]);
    const logRecords = decodeLogsExport(logsRequest.body).resourceLogs.flatMap(
      (resourceLogs) =>
        resourceLogs.scopeLogs.flatMap((scopeLogs) => scopeLogs.logRecords),
    );
    expect(logRecords.map((record) => record.body?.stringValue)).toEqual([
      "something happened",
    ]);
    const metricNames = decodeMetricsExport(
      metricsRequest.body,
    ).resourceMetrics.flatMap((resourceMetrics) =>
      resourceMetrics.scopeMetrics.flatMap((scopeMetrics) =>
        scopeMetrics.metrics.map((metric) => metric.name),
      ),
    );
    expect(metricNames).toEqual(["app.things"]);
    expect(spool.pendingFiles()).toEqual([]);
  });

  it("exports on its own timer shortly after start", async () => {
    const worker = createWorker({ initialExportDelayMillis: 1 });
    await spool.append("traces", buildTracePayload("GET /items"));
    worker.start();
    await server.waitForRequests(1);
    expect(server.paths()).toEqual(["/v1/traces"]);
  });

  it("retries a failed send next cycle with a byte-identical payload", async () => {
    const statuses = [503];
    server.respond = () => ({ status: statuses.shift() ?? 200 });
    const worker = createWorker();
    await spool.append("traces", buildTracePayload("GET /items"));
    await worker.runCycle();
    expect(spool.pendingFiles()).toHaveLength(1);
    await worker.runCycle();
    expect(spool.pendingFiles()).toEqual([]);
    expect(server.paths()).toEqual(["/v1/traces", "/v1/traces"]);
    const [first, second] = server.requests;
    expect(first.body.equals(second.body)).toBe(true);
    expect(spanNames(decodeTraceExport(first.body))).toEqual(["GET /items"]);
  });

  it("sends one probe per cycle during an outage and delivers data byte-identically after recovery", async () => {
    let failing = true;
    server.respond = () => ({ status: failing ? 503 : 200 });
    const worker = createWorker();
    for (const name of ["GET /a", "GET /b", "GET /c"]) {
      await spool.append("traces", buildTracePayload(name));
      await worker.runCycle();
    }
    expect(server.paths()).toEqual(["/v1/traces", "/v1/traces", "/v1/traces"]);
    expect(spool.pendingFiles()).toHaveLength(1);
    const probeBodies = server.requests.map((request) => request.body);
    expect(probeBodies[1].equals(probeBodies[0])).toBe(true);
    expect(probeBodies[2].equals(probeBodies[0])).toBe(true);
    failing = false;
    await worker.runCycle();
    await worker.runCycle();
    expect(spool.pendingFiles()).toEqual([]);
    const delivered = server.requests.slice(3);
    expect(delivered[0].body.equals(probeBodies[0])).toBe(true);
    const deliveredNames = delivered.flatMap((request) =>
      spanNames(decodeTraceExport(request.body)),
    );
    expect(deliveredNames).toEqual(["GET /a", "GET /b", "GET /c"]);
  });

  it("sends at most ten files per regular cycle", async () => {
    const worker = createWorker();
    await appendClosedTraceFiles(MAX_SENDS_PER_CYCLE + 2);
    await worker.runCycle();
    expect(server.requests).toHaveLength(MAX_SENDS_PER_CYCLE);
    expect(spool.pendingFiles()).toHaveLength(2);
  });

  it.each([
    { value: "30", expectedMillis: 30_000 },
    { value: "1", expectedMillis: 5_000 },
    { value: "10000", expectedMillis: 60_000 },
  ])(
    "adjusts the export interval to $expectedMillis ms when the response header is $value",
    async ({ value, expectedMillis }) => {
      server.respond = () => ({
        status: 200,
        headers: { "Apitally-Export-Interval": value },
      });
      const worker = createWorker();
      await spool.append("traces", buildTracePayload("GET /items"));
      await worker.runCycle();
      expect(worker.intervalMillis).toBe(expectedMillis);
    },
  );

  it("ignores a non-integer export interval header", async () => {
    server.respond = () => ({
      status: 200,
      headers: { "Apitally-Export-Interval": "soon" },
    });
    const worker = createWorker();
    const intervalBefore = worker.intervalMillis;
    await spool.append("traces", buildTracePayload("GET /items"));
    await worker.runCycle();
    expect(worker.intervalMillis).toBe(intervalBefore);
  });

  it("coalesces a flush requested mid-cycle with the running cycle so no file posts twice", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.respond = async () => {
      await gate;
      return { status: 200 };
    };
    const worker = createWorker();
    await spool.append("traces", buildTracePayload("GET /items"));
    await spool.append("logs", buildLogsPayload("hello"));
    const runningCycle = worker.runCycle();
    await server.waitForRequests(1);
    const flush = worker.runCycle();
    release();
    await runningCycle;
    await flush;
    expect(server.paths()).toEqual(["/v1/traces", "/v1/logs"]);
    expect(spool.pendingFiles()).toEqual([]);
  });

  it("runs flush callbacks under suppressed tracing at the start of each cycle", async () => {
    enableAsyncContextManager();
    const worker = createWorker();
    const suppressed: boolean[] = [];
    worker.flushCallbacks.push(() => {
      suppressed.push(isTracingSuppressed(context.active()));
    });
    await worker.runCycle();
    await worker.runCycle();
    expect(suppressed).toEqual([true, true]);
    expect(isTracingSuppressed(context.active())).toBe(false);
  });

  it("routes the export POST through the proxy when HTTP_PROXY is set", async () => {
    const proxy = await StubOtlpServer.start();
    try {
      process.env.HTTP_PROXY = proxy.url;
      const worker = createWorker();
      const payload = buildTracePayload("GET /items");
      await spool.append("traces", payload);
      await worker.runCycle();
      expect(server.paths()).toEqual(["/v1/traces"]);
      expect(proxy.connectTargets).toEqual([`127.0.0.1:${server.port}`]);
      expect(gunzipSync(server.requests[0].body)).toEqual(Buffer.from(payload));
      expect(spool.pendingFiles()).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("drops a permanently rejected file with one warning per status while the cycle continues", async () => {
    server.respond = (path) => ({
      status: path === "/v1/traces" ? 402 : 200,
    });
    const worker = createWorker();
    const lines = captureStderr();
    await spool.append("traces", buildTracePayload("GET /a"));
    await spool.append("logs", buildLogsPayload("hello"));
    await worker.runCycle();
    expect(server.paths()).toEqual(["/v1/traces", "/v1/logs"]);
    expect(spool.pendingFiles()).toEqual([]);
    await spool.append("traces", buildTracePayload("GET /b"));
    await worker.runCycle();
    expect(spool.pendingFiles()).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("402");
  });

  it.each([{ status: 408 }, { status: 429 }, { status: 500 }, { status: 503 }])(
    "keeps the file queued for the next cycle when the server responds $status",
    async ({ status }) => {
      server.respond = () => ({ status });
      const worker = createWorker();
      const lines = captureStderr();
      await spool.append("traces", buildTracePayload("GET /items"));
      await worker.runCycle();
      expect(server.paths()).toEqual(["/v1/traces"]);
      expect(spool.pendingFiles()).toHaveLength(1);
      expect(lines).toEqual([]);
    },
  );

  it("keeps files queued and ends the cycle on a connection error", async () => {
    const unusedPort = await findUnusedPort();
    const worker = createWorker({
      otlpEndpoint: `http://127.0.0.1:${unusedPort}`,
    });
    await spool.append("traces", buildTracePayload("GET /a"));
    await spool.rotateForExport();
    await spool.append("logs", buildLogsPayload("hello"));
    await worker.runCycle();
    const files = spool.pendingFiles();
    expect(files.map((file) => file.signal)).toEqual(["traces", "logs"]);
    expect(files[0].firstAttemptAtMillis).toBeDefined();
    expect(files[1].firstAttemptAtMillis).toBeUndefined();
  });

  it("re-posts immediately once when a connection error interrupts a send", async () => {
    let destroyed = false;
    server.respond = () => {
      if (!destroyed) {
        destroyed = true;
        return { status: 200, destroySocket: true };
      }
      return { status: 200 };
    };
    const worker = createWorker();
    await spool.append("traces", buildTracePayload("GET /items"));
    await worker.runCycle();
    expect(server.paths()).toEqual(["/v1/traces", "/v1/traces"]);
    expect(server.requests[0].body.equals(server.requests[1].body)).toBe(true);
    expect(spool.pendingFiles()).toEqual([]);
  });

  it("aborts a hung POST at the configured timeout without an immediate re-post", async () => {
    server.respond = () => ({ status: 200, hang: true });
    const worker = createWorker({ requestTimeoutMillis: 50 });
    await spool.append("traces", buildTracePayload("GET /items"));
    await worker.runCycle();
    expect(server.paths()).toEqual(["/v1/traces"]);
    expect(spool.pendingFiles()).toHaveLength(1);
  });

  it("drops an expired file at the final drain while a never-attempted file still delivers", async () => {
    const worker = createWorker();
    await spool.append("traces", buildTracePayload("GET /old"));
    await spool.append("logs", buildLogsPayload("fresh"));
    await spool.rotateForExport();
    const [tracesFile] = spool
      .pendingFiles()
      .filter((file) => file.signal === "traces");
    tracesFile.firstAttemptAtMillis =
      performance.now() - MAX_RETRY_TIME_AFTER_FIRST_ATTEMPT_MILLIS - 1;
    const lines = captureStderr();
    await worker.finalDrain();
    expect(server.paths()).toEqual(["/v1/logs"]);
    expect(spool.pendingFiles()).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("traces");
  });

  it("delivers every pending and current file in one final drain", async () => {
    const worker = createWorker();
    const names = await appendClosedTraceFiles(MAX_SENDS_PER_CYCLE + 2);
    await spool.append("traces", buildTracePayload("GET /last"));
    names.push("GET /last");
    await worker.finalDrain();
    expect(server.paths()).toEqual(Array(names.length).fill("/v1/traces"));
    expect(spool.pendingFiles()).toEqual([]);
    const deliveredNames = server.requests.flatMap((request) =>
      spanNames(decodeTraceExport(request.body)),
    );
    expect(deliveredNames).toEqual(names);
  });
});
