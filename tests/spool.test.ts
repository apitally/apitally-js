import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RETRY_TIME_AFTER_FIRST_ATTEMPT_MILLIS,
  MAX_UNCOMPRESSED_FILE_SIZE,
  type Signal,
  Spool,
} from "../src/spool.js";
import { captureStderr } from "./utils.js";

const TRACE_PAYLOAD_A = Buffer.from("trace-a");
const TRACE_PAYLOAD_B = Buffer.from("trace-b");
const TRACE_PAYLOAD_C = Buffer.from("trace-c");

describe("spool", () => {
  let tempDir: string;
  let spool: Spool | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "apitally-test-"));
  });

  afterEach(async () => {
    await spool?.clear();
    spool = undefined;
    chmodSync(tempDir, 0o700);
    await rm(tempDir, { recursive: true, force: true });
  });

  const backends = [{ backend: "disk" }, { backend: "memory" }] as const;

  // Suppress spool warnings here; warning tests start a fresh capture. A missing
  // directory selects the memory backend.
  function createSpool(backend: "disk" | "memory"): Spool {
    captureStderr();
    spool = backend === "memory" ? new Spool(join(tempDir, "missing")) : new Spool(tempDir);
    return spool;
  }

  it.each(backends)("preserves append order in one closed file ($backend)", async ({ backend }) => {
    const spool = createSpool(backend);
    await spool.append("traces", TRACE_PAYLOAD_A);
    await spool.append("traces", TRACE_PAYLOAD_B);
    await spool.rotateForExport();
    const files = spool.pendingFiles();
    expect(files).toHaveLength(1);
    const storedBytes = await files[0].readStoredBytes();
    expect(gunzipSync(storedBytes)).toEqual(Buffer.concat([TRACE_PAYLOAD_A, TRACE_PAYLOAD_B]));
  });

  it("writes a closed file fully to disk with owner-only permissions", async () => {
    const spool = createSpool("disk");
    await spool.append("traces", TRACE_PAYLOAD_C);
    await spool.rotateForExport();
    const [file] = spool.pendingFiles();
    expect(file.path).toBeDefined();
    const stats = await stat(file.path as string);
    expect(stats.size).toBe(file.storedSize);
    expect(stats.size).toBeGreaterThan(0);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(gunzipSync(await readFile(file.path as string))).toEqual(TRACE_PAYLOAD_C);
  });

  it.each(backends)(
    "rotates the current file before an append crosses the uncompressed size threshold ($backend)",
    async ({ backend }) => {
      const spool = createSpool(backend);
      const first = Buffer.alloc(3_000_000, "a");
      const second = Buffer.alloc(2_000_000, "b");
      await spool.append("traces", first);
      await spool.append("traces", second);
      const files = spool.pendingFiles();
      expect(files).toHaveLength(1);
      expect(files[0].uncompressedSize).toBe(3_000_000);
      expect(files[0].uncompressedSize).toBeLessThanOrEqual(MAX_UNCOMPRESSED_FILE_SIZE);
      // Buffer.equals avoids slow element-wise comparison of megabyte buffers.
      expect(gunzipSync(await files[0].readStoredBytes()).equals(first)).toBe(true);
      expect(spool.current.get("traces")?.uncompressedSize).toBe(2_000_000);
    },
  );

  it.each(backends)(
    "delivers a complete append when a flush is requested while its streams are still flushing ($backend)",
    async ({ backend }) => {
      const spool = createSpool(backend);
      const payload = randomBytes(1_000_000);
      void spool.append("traces", payload);
      await spool.closeCurrentFiles();
      const files = spool.pendingFiles();
      expect(files).toHaveLength(1);
      expect(gunzipSync(await files[0].readStoredBytes()).equals(payload)).toBe(true);
    },
  );

  it.each(backends)(
    "evicts the oldest non-metrics files first when the size cap is exceeded ($backend)",
    async ({ backend }) => {
      const spool = createSpool(backend);
      await spool.append("metrics", randomBytes(10_000));
      await spool.rotateForExport();
      await spool.append("traces", randomBytes(10_000));
      await spool.append("logs", randomBytes(10_000));
      await spool.rotateForExport();
      const files = spool.pendingFiles();
      expect(files.map((file) => file.signal)).toEqual(["metrics", "traces", "logs"]);
      spool.maxSize = files.reduce((total, file) => total + file.storedSize, 0) - 1;
      await spool.rotateForExport();
      expect(spool.pendingFiles().map((file) => file.signal)).toEqual(["metrics", "logs"]);
      spool.maxSize = 0;
      await spool.rotateForExport();
      expect(spool.pendingFiles()).toEqual([]);
    },
  );

  it.each(backends)(
    "drops attempted files after the retention window while never-attempted files stay ($backend)",
    async ({ backend }) => {
      const spool = createSpool(backend);
      for (const signal of ["traces", "metrics", "logs"] as Signal[]) {
        await spool.append(signal, Buffer.from("payload"));
      }
      await spool.rotateForExport();
      for (const file of spool.pendingFiles()) {
        if (file.signal !== "logs") {
          file.firstAttemptAtMillis =
            performance.now() - MAX_RETRY_TIME_AFTER_FIRST_ATTEMPT_MILLIS - 1;
        }
      }
      const expiredPaths = spool
        .pendingFiles()
        .filter((file) => file.signal !== "logs")
        .map((file) => file.path);
      const lines = captureStderr();
      await spool.rotateForExport();
      expect(spool.pendingFiles().map((file) => file.signal)).toEqual(["logs"]);
      for (const path of expiredPaths) {
        if (path) {
          expect(existsSync(path)).toBe(false);
        }
      }
      expect(lines).toHaveLength(2);
      expect(lines.join("")).toContain("traces");
      expect(lines.join("")).toContain("metrics");
    },
  );

  it("removes orphaned files untouched for two hours at construction while live files survive", async () => {
    const orphanPath = join(tempDir, "apitally-orphan.gz");
    writeFileSync(orphanPath, "stale");
    const spool = createSpool("disk");
    await spool.append("traces", Buffer.from("first"));
    await spool.rotateForExport();
    await spool.append("traces", Buffer.from("second"));
    const livePaths = [
      ...spool.pendingFiles().map((file) => file.path as string),
      spool.current.get("traces")?.path as string,
    ];
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (const path of [orphanPath, ...livePaths]) {
      utimesSync(path, staleTime, staleTime);
    }
    spool.touchFiles();
    new Spool(tempDir);
    expect(existsSync(orphanPath)).toBe(false);
    for (const path of livePaths) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("falls back to in-memory buffering with a single warning when the temp dir is not writable", async () => {
    const lines = captureStderr();
    spool = new Spool(join(tempDir, "missing"));
    expect(spool.inMemory).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("memory");
    await spool.append("traces", TRACE_PAYLOAD_C);
    await spool.rotateForExport();
    const [file] = spool.pendingFiles();
    expect(file.path).toBeUndefined();
    const storedBytes = await file.readStoredBytes();
    expect(gunzipSync(storedBytes)).toEqual(TRACE_PAYLOAD_C);
  });

  it.each(backends)(
    "discards the current file and recovers when a stream errors mid-append ($backend)",
    async ({ backend }) => {
      const spool = createSpool(backend);
      await spool.append("traces", Buffer.from("first"));
      const failedFile = spool.current.get("traces");
      if (!failedFile) {
        throw new Error("Expected a current traces file");
      }
      const lines = captureStderr();
      failedFile.gzip.destroy(new Error("disk full"));
      await spool.append("traces", Buffer.from("second"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("traces");
      expect(spool.current.get("traces")).toBeUndefined();
      if (failedFile.path) {
        expect(existsSync(failedFile.path)).toBe(false);
      }
      await spool.append("traces", Buffer.from("third"));
      await spool.rotateForExport();
      const [file] = spool.pendingFiles();
      expect(gunzipSync(await file.readStoredBytes())).toEqual(Buffer.from("third"));
    },
  );

  it("keeps running with a single warning when file creation fails repeatedly and recovers", async () => {
    const spool = createSpool("disk");
    const lines = captureStderr();
    chmodSync(tempDir, 0o500);
    await spool.append("traces", Buffer.from("first"));
    await spool.append("traces", Buffer.from("second"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("traces");
    expect(spool.pendingFiles()).toEqual([]);
    chmodSync(tempDir, 0o700);
    await spool.append("traces", Buffer.from("third"));
    await spool.rotateForExport();
    const [file] = spool.pendingFiles();
    expect(gunzipSync(await file.readStoredBytes())).toEqual(Buffer.from("third"));
  });
});
