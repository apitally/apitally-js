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
import { StubOtlpServer } from "../stubOtlpServer.js";
import {
  captureStderr,
  enableAsyncContextManager,
  readPackageVersion,
  WRITE_TOKEN,
} from "../utils.js";

const TRACE_PAYLOAD_ITEMS = Buffer.from("trace-items");
const TRACE_PAYLOAD_A = Buffer.from("trace-a");
const TRACE_PAYLOAD_B = Buffer.from("trace-b");
const TRACE_PAYLOAD_C = Buffer.from("trace-c");
const TRACE_PAYLOAD_OLD = Buffer.from("trace-old");
const TRACE_PAYLOAD_LAST = Buffer.from("trace-last");
const LOGS_PAYLOAD_HELLO = Buffer.from("logs-hello");
const LOGS_PAYLOAD_HAPPENED = Buffer.from("logs-happened");
const LOGS_PAYLOAD_FRESH = Buffer.from("logs-fresh");
const METRICS_PAYLOAD_THINGS = Buffer.from("metrics-things");

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

  async function appendClosedTraceFiles(count: number): Promise<Buffer[]> {
    const payloads: Buffer[] = [];
    for (let index = 0; index < count; index++) {
      const payload = Buffer.from(`trace-${index}`);
      payloads.push(payload);
      await spool.append("traces", payload);
      await spool.closeCurrentFiles();
    }
    return payloads;
  }

  it("posts all three signals with export headers in one cycle", async () => {
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await spool.append("logs", LOGS_PAYLOAD_HAPPENED);
    await spool.append("metrics", METRICS_PAYLOAD_THINGS);
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
    expect(gunzipSync(traceRequest.body)).toEqual(TRACE_PAYLOAD_ITEMS);
    expect(gunzipSync(logsRequest.body)).toEqual(LOGS_PAYLOAD_HAPPENED);
    expect(gunzipSync(metricsRequest.body)).toEqual(METRICS_PAYLOAD_THINGS);
    expect(spool.pendingFiles()).toEqual([]);
  });

  it("exports on its own timer shortly after start", async () => {
    const worker = createWorker({ initialExportDelayMillis: 1 });
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    worker.start();
    await server.waitForRequests(1);
    expect(server.paths()).toEqual(["/v1/traces"]);
  });

  it("retries a failed send next cycle with a byte-identical payload", async () => {
    const statuses = [503];
    server.respond = () => ({ status: statuses.shift() ?? 200 });
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await worker.runCycle();
    expect(spool.pendingFiles()).toHaveLength(1);
    await worker.runCycle();
    expect(spool.pendingFiles()).toEqual([]);
    expect(server.paths()).toEqual(["/v1/traces", "/v1/traces"]);
    const [first, second] = server.requests;
    expect(first.body.equals(second.body)).toBe(true);
    expect(gunzipSync(first.body)).toEqual(TRACE_PAYLOAD_ITEMS);
  });

  it("sends one probe per cycle during an outage and delivers data byte-identically after recovery", async () => {
    let failing = true;
    server.respond = () => ({ status: failing ? 503 : 200 });
    const worker = createWorker();
    const payloads = [TRACE_PAYLOAD_A, TRACE_PAYLOAD_B, TRACE_PAYLOAD_C];
    for (const payload of payloads) {
      await spool.append("traces", payload);
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
    const expectedConcatenated = Buffer.concat(payloads);
    const deliveredConcatenated = Buffer.concat(
      delivered.map((request) => gunzipSync(request.body)),
    );
    expect(deliveredConcatenated).toEqual(expectedConcatenated);
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
      await spool.append("traces", TRACE_PAYLOAD_ITEMS);
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
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
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
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await spool.append("logs", LOGS_PAYLOAD_HELLO);
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
      await spool.append("traces", TRACE_PAYLOAD_ITEMS);
      await worker.runCycle();
      expect(server.paths()).toEqual(["/v1/traces"]);
      expect(proxy.connectTargets).toEqual([`127.0.0.1:${server.port}`]);
      expect(gunzipSync(server.requests[0].body)).toEqual(TRACE_PAYLOAD_ITEMS);
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
    await spool.append("traces", TRACE_PAYLOAD_A);
    await spool.append("logs", LOGS_PAYLOAD_HELLO);
    await worker.runCycle();
    expect(server.paths()).toEqual(["/v1/traces", "/v1/logs"]);
    expect(spool.pendingFiles()).toEqual([]);
    await spool.append("traces", TRACE_PAYLOAD_B);
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
      await spool.append("traces", TRACE_PAYLOAD_ITEMS);
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
    await spool.append("traces", TRACE_PAYLOAD_A);
    await spool.rotateForExport();
    await spool.append("logs", LOGS_PAYLOAD_HELLO);
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
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await worker.runCycle();
    expect(server.paths()).toEqual(["/v1/traces", "/v1/traces"]);
    expect(server.requests[0].body.equals(server.requests[1].body)).toBe(true);
    expect(spool.pendingFiles()).toEqual([]);
  });

  it("aborts a hung POST at the configured timeout without an immediate re-post", async () => {
    server.respond = () => ({ status: 200, hang: true });
    const worker = createWorker({ requestTimeoutMillis: 50 });
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await worker.runCycle();
    expect(server.paths()).toEqual(["/v1/traces"]);
    expect(spool.pendingFiles()).toHaveLength(1);
  });

  it("drops an expired file at the final drain while a never-attempted file still delivers", async () => {
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_OLD);
    await spool.append("logs", LOGS_PAYLOAD_FRESH);
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
    const expectedPayloads = await appendClosedTraceFiles(
      MAX_SENDS_PER_CYCLE + 2,
    );
    await spool.append("traces", TRACE_PAYLOAD_LAST);
    expectedPayloads.push(TRACE_PAYLOAD_LAST);
    await worker.finalDrain();
    expect(server.paths()).toEqual(
      Array(expectedPayloads.length).fill("/v1/traces"),
    );
    expect(spool.pendingFiles()).toEqual([]);
    const deliveredPayloads = server.requests.map((request) =>
      gunzipSync(request.body),
    );
    expect(deliveredPayloads).toEqual(expectedPayloads);
  });
});
