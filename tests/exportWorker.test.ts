import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { context } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportWorker, type ExportWorkerOptions } from "../src/exportWorker.js";
import { Spool } from "../src/spool.js";
import {
  captureStderr,
  enableAsyncContextManager,
  readFetchPaths,
  readPackageVersion,
  spyOnSuccessfulFetch,
  WRITE_TOKEN,
  withServer,
} from "./utils.js";

const undici = createRequire(import.meta.url)("undici") as typeof import("undici");
const TEST_ENDPOINT = "https://otlp.example";
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

interface ReceivedRequest {
  path: string;
  method?: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

describe("exportWorker", () => {
  let tempDir: string;
  let spool: Spool;
  let worker: ExportWorker | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "apitally-test-"));
    spool = new Spool(tempDir);
  });

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await spool.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  function createWorker(overrides: Partial<ExportWorkerOptions> = {}): ExportWorker {
    worker = new ExportWorker({
      spool,
      otlpEndpoint: TEST_ENDPOINT,
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

  it("constructs the export request with the stored gzip bytes", async () => {
    const fetchSpy = spyOnSuccessfulFetch();
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await worker.runCycle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${TEST_ENDPOINT}/v1/traces`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers)).toEqual(
      new Headers({
        Authorization: `Bearer ${WRITE_TOKEN}`,
        "Apitally-Env": "dev",
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "gzip",
        "User-Agent": `apitally-js/${readPackageVersion()}`,
      }),
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(gunzipSync(init?.body as Buffer)).toEqual(TRACE_PAYLOAD_ITEMS);
    expect(spool.pendingFiles()).toEqual([]);
  });

  it("posts all three signals with export headers in one cycle", async () => {
    const requests: ReceivedRequest[] = [];
    await withServer(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          requests.push({
            path: request.url ?? "",
            method: request.method,
            headers: request.headers,
            body: Buffer.concat(chunks),
          });
          response.writeHead(200);
          response.end();
        });
      },
      async (_server, baseUrl) => {
        const worker = createWorker({ otlpEndpoint: baseUrl });
        await spool.append("traces", TRACE_PAYLOAD_ITEMS);
        await spool.append("logs", LOGS_PAYLOAD_HAPPENED);
        await spool.append("metrics", METRICS_PAYLOAD_THINGS);
        await worker.runCycle();
      },
    );

    expect(requests.map((request) => request.path)).toEqual([
      "/v1/traces",
      "/v1/logs",
      "/v1/metrics",
    ]);
    const version = readPackageVersion();
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe(`Bearer ${WRITE_TOKEN}`);
      expect(request.headers["apitally-env"]).toBe("dev");
      expect(request.headers["content-type"]).toBe("application/x-protobuf");
      expect(request.headers["content-encoding"]).toBe("gzip");
      expect(request.headers["user-agent"]).toBe(`apitally-js/${version}`);
    }
    const [traceRequest, logsRequest, metricsRequest] = requests;
    expect(gunzipSync(traceRequest.body)).toEqual(TRACE_PAYLOAD_ITEMS);
    expect(gunzipSync(logsRequest.body)).toEqual(LOGS_PAYLOAD_HAPPENED);
    expect(gunzipSync(metricsRequest.body)).toEqual(METRICS_PAYLOAD_THINGS);
    expect(spool.pendingFiles()).toEqual([]);
  });

  it("exports on its own timer shortly after start", async () => {
    let observeFetch = () => {};
    const fetchObserved = new Promise<void>((resolve) => {
      observeFetch = resolve;
    });
    let releaseFetch = (_response: Response) => {};
    const heldResponse = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => {
      observeFetch();
      return heldResponse;
    });
    const worker = createWorker({ initialExportDelayMillis: 0 });
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    worker.start();
    await fetchObserved;
    const joinedCycle = worker.runCycle();
    releaseFetch(new Response(null, { status: 200 }));
    await joinedCycle;
    expect(readFetchPaths(fetchSpy)).toEqual(["/v1/traces"]);
  });

  it("retries a failed send next cycle with a byte-identical payload", async () => {
    const statuses = [503];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(null, {
          status: statuses.shift() ?? 200,
        }),
    );
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await worker.runCycle();
    expect(spool.pendingFiles()).toHaveLength(1);
    await worker.runCycle();
    expect(spool.pendingFiles()).toEqual([]);
    expect(readFetchPaths(fetchSpy)).toEqual(["/v1/traces", "/v1/traces"]);
    const firstBody = fetchSpy.mock.calls[0][1]?.body as Buffer;
    const secondBody = fetchSpy.mock.calls[1][1]?.body as Buffer;
    expect(firstBody.equals(secondBody)).toBe(true);
    expect(gunzipSync(firstBody)).toEqual(TRACE_PAYLOAD_ITEMS);
  });

  it("sends one probe per cycle during an outage and delivers data byte-identically after recovery", async () => {
    let isFailing = true;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: isFailing ? 503 : 200 }));
    const worker = createWorker();
    const payloads = [TRACE_PAYLOAD_A, TRACE_PAYLOAD_B, TRACE_PAYLOAD_C];
    for (const payload of payloads) {
      await spool.append("traces", payload);
      await worker.runCycle();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(spool.pendingFiles()).toHaveLength(1);
    const probeBodies = fetchSpy.mock.calls.map(([, init]) => init?.body as Buffer);
    expect(probeBodies[1].equals(probeBodies[0])).toBe(true);
    expect(probeBodies[2].equals(probeBodies[0])).toBe(true);
    isFailing = false;
    await worker.runCycle();
    await worker.runCycle();
    expect(spool.pendingFiles()).toEqual([]);
    const deliveredBodies = fetchSpy.mock.calls.slice(3).map(([, init]) => init?.body as Buffer);
    expect(deliveredBodies[0].equals(probeBodies[0])).toBe(true);
    expect(Buffer.concat(deliveredBodies.map((body) => gunzipSync(body)))).toEqual(
      Buffer.concat(payloads),
    );
  });

  it("sends at most ten files per regular cycle", async () => {
    const fetchSpy = spyOnSuccessfulFetch();
    const worker = createWorker();
    await appendClosedTraceFiles(12);
    await worker.runCycle();
    expect(fetchSpy).toHaveBeenCalledTimes(10);
    expect(spool.pendingFiles()).toHaveLength(2);
  });

  it.each([
    { value: "30", expectedMillis: 30_000 },
    { value: "1", expectedMillis: 5_000 },
    { value: "10000", expectedMillis: 60_000 },
  ])(
    "adjusts the export interval to $expectedMillis ms when the response header is $value",
    async ({ value, expectedMillis }) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(null, {
            status: 200,
            headers: { "Apitally-Export-Interval": value },
          }),
      );
      const worker = createWorker();
      await spool.append("traces", TRACE_PAYLOAD_ITEMS);
      await worker.runCycle();
      expect(worker.intervalMillis).toBe(expectedMillis);
    },
  );

  it("ignores a non-integer export interval header", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "Apitally-Export-Interval": "soon" },
        }),
    );
    const worker = createWorker();
    const intervalBefore = worker.intervalMillis;
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await worker.runCycle();
    expect(worker.intervalMillis).toBe(intervalBefore);
  });

  it("coalesces a flush requested mid-cycle with the running cycle so no file posts twice", async () => {
    let observeFetch = () => {};
    const fetchObserved = new Promise<void>((resolve) => {
      observeFetch = resolve;
    });
    let releaseFetch = (_response: Response) => {};
    const heldResponse = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        observeFetch();
        return heldResponse;
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await spool.append("logs", LOGS_PAYLOAD_HELLO);
    const runningCycle = worker.runCycle();
    await fetchObserved;
    const flush = worker.runCycle();
    releaseFetch(new Response(null, { status: 200 }));
    await runningCycle;
    await flush;
    expect(readFetchPaths(fetchSpy)).toEqual(["/v1/traces", "/v1/logs"]);
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

  it("uses an environment proxy agent when HTTP_PROXY is set", async () => {
    process.env.HTTP_PROXY = "http://proxy.example:8080";
    const fetchSpy = vi
      .spyOn(undici, "fetch")
      .mockImplementation(async () => new undici.Response(null, { status: 200 }));
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await worker.runCycle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${TEST_ENDPOINT}/v1/traces`);
    expect(gunzipSync(init?.body as Buffer)).toEqual(TRACE_PAYLOAD_ITEMS);
    expect(init?.dispatcher).toBeInstanceOf(undici.EnvHttpProxyAgent);
    expect(spool.pendingFiles()).toEqual([]);
  });

  it("drops a permanently rejected file with one warning per status while the cycle continues", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url) =>
        new Response(null, {
          status: String(url).endsWith("/v1/traces") ? 402 : 200,
        }),
    );
    const worker = createWorker();
    const lines = captureStderr();
    await spool.append("traces", TRACE_PAYLOAD_A);
    await spool.append("logs", LOGS_PAYLOAD_HELLO);
    await worker.runCycle();
    expect(readFetchPaths(fetchSpy)).toEqual(["/v1/traces", "/v1/logs"]);
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
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response(null, { status }));
      const worker = createWorker();
      const lines = captureStderr();
      await spool.append("traces", TRACE_PAYLOAD_ITEMS);
      await worker.runCycle();
      expect(readFetchPaths(fetchSpy)).toEqual(["/v1/traces"]);
      expect(spool.pendingFiles()).toHaveLength(1);
      expect(lines).toEqual([]);
    },
  );

  it("retries a connection error once, keeps the queue, and ends the cycle", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_A);
    await spool.rotateForExport();
    await spool.append("logs", LOGS_PAYLOAD_HELLO);
    await worker.runCycle();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(readFetchPaths(fetchSpy)).toEqual(["/v1/traces", "/v1/traces"]);
    const firstBody = fetchSpy.mock.calls[0][1]?.body as Buffer;
    const secondBody = fetchSpy.mock.calls[1][1]?.body as Buffer;
    expect(firstBody.equals(secondBody)).toBe(true);
    const files = spool.pendingFiles();
    expect(files.map((file) => file.signal)).toEqual(["traces", "logs"]);
    expect(files[0].firstAttemptAtMillis).toBeDefined();
    expect(files[1].firstAttemptAtMillis).toBeUndefined();
  });

  it("aborts a timed-out POST without an immediate retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Expected request signal"));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const worker = createWorker({ requestTimeoutMillis: 10 });
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await worker.runCycle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(spool.pendingFiles()).toHaveLength(1);
  });

  it("cancels an active export before a bounded final drain sends the retained file", async () => {
    let observeFirstRequest = () => {};
    const firstRequestStarted = new Promise<void>((resolve) => {
      observeFirstRequest = resolve;
    });
    let requestCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      requestCount += 1;
      if (requestCount > 1) {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      observeFirstRequest();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Expected request signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    const runningCycle = worker.runCycle();
    await firstRequestStarted;

    await worker.finalDrain(1_000);
    await runningCycle;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBody = fetchSpy.mock.calls[0][1]?.body as Buffer;
    const secondBody = fetchSpy.mock.calls[1][1]?.body as Buffer;
    expect(firstBody.equals(secondBody)).toBe(true);
    expect(gunzipSync(secondBody)).toEqual(TRACE_PAYLOAD_ITEMS);
    expect(spool.pendingFiles()).toEqual([]);
  });

  it("stops a bounded final drain at its deadline and retains the unsent file", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Expected request signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_ITEMS);
    await spool.closeCurrentFiles();

    await worker.finalDrain(50);
    await worker.waitForIdle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(spool.pendingFiles()).toHaveLength(1);
  });

  it("drops an expired file at the final drain while a never-attempted file still delivers", async () => {
    const fetchSpy = spyOnSuccessfulFetch();
    const worker = createWorker();
    await spool.append("traces", TRACE_PAYLOAD_OLD);
    await spool.append("logs", LOGS_PAYLOAD_FRESH);
    await spool.rotateForExport();
    const [tracesFile] = spool.pendingFiles().filter((file) => file.signal === "traces");
    tracesFile.firstAttemptAtMillis = performance.now() - 60 * 60 * 1000;
    const lines = captureStderr();
    await worker.finalDrain();
    expect(readFetchPaths(fetchSpy)).toEqual(["/v1/logs"]);
    expect(spool.pendingFiles()).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("traces");
  });

  it("delivers every pending and current file in one final drain", async () => {
    const fetchSpy = spyOnSuccessfulFetch();
    const worker = createWorker();
    const expectedPayloads = await appendClosedTraceFiles(12);
    await spool.append("traces", TRACE_PAYLOAD_LAST);
    expectedPayloads.push(TRACE_PAYLOAD_LAST);
    await worker.finalDrain();
    expect(readFetchPaths(fetchSpy)).toEqual(Array(expectedPayloads.length).fill("/v1/traces"));
    expect(spool.pendingFiles()).toEqual([]);
    expect(fetchSpy.mock.calls.map(([, init]) => gunzipSync(init?.body as Buffer))).toEqual(
      expectedPayloads,
    );
  });
});
