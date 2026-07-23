import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  type WriteStream,
  writeFileSync,
} from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip, type Gzip } from "node:zlib";
import { logWarning } from "./logger.js";

const SIGNALS = ["traces", "logs", "metrics"] as const;
export type Signal = (typeof SIGNALS)[number];

export const MAX_UNCOMPRESSED_FILE_SIZE = 4_000_000;
export const MAX_RETRY_TIME_AFTER_FIRST_ATTEMPT_MILLIS = 59 * 60 * 1000;
const MAX_SPOOL_SIZE_DISK = 50_000_000;
const MAX_SPOOL_SIZE_MEMORY = 10_000_000;
const MAX_UNTOUCHED_FILE_AGE_MILLIS = 2 * 60 * 60 * 1000;
const SPOOL_FILE_NAME_PATTERN = /^apitally-.*\.gz$/;

// Byte spool between the batch processors and the export worker. Gzip and file
// streams complete across event-loop turns, so all operations on a signal's
// current file are serialized on one per-signal operation queue.
export class Spool {
  readonly inMemory: boolean;
  maxSize: number;
  readonly current = new Map<Signal, SpoolFile>();
  private readonly closed: SpoolFile[] = [];
  private readonly tempDir: string;
  private readonly queues: Record<Signal, Promise<void>> = {
    traces: Promise.resolve(),
    logs: Promise.resolve(),
    metrics: Promise.resolve(),
  };

  constructor(tempDir: string = tmpdir()) {
    this.tempDir = tempDir;
    this.inMemory = !isTempDirWritable(tempDir);
    if (this.inMemory) {
      logWarning(
        `Unable to create temporary files, buffering telemetry in memory (max ${MAX_SPOOL_SIZE_MEMORY / 1_000_000} MB)`,
      );
    } else {
      cleanupOrphanedFiles(tempDir);
    }
    this.maxSize = this.inMemory ? MAX_SPOOL_SIZE_MEMORY : MAX_SPOOL_SIZE_DISK;
  }

  append(signal: Signal, payload: Uint8Array): Promise<void> {
    return this.enqueue(signal, async () => {
      let file = this.current.get(signal);
      if (
        file &&
        file.uncompressedSize + payload.length > MAX_UNCOMPRESSED_FILE_SIZE
      ) {
        await this.closeCurrentFile(signal);
        file = undefined;
      }
      try {
        if (!file) {
          file = new SpoolFile(
            signal,
            this.inMemory ? undefined : this.tempDir,
          );
          this.current.set(signal, file);
        }
        await file.write(payload);
      } catch {
        logWarning(
          `Error writing telemetry to disk, dropping buffered ${signal}`,
        );
        await this.discardCurrentFile(signal);
      }
      await this.evict();
    });
  }

  // Close each signal's current file so it becomes sendable, unless closed
  // files are already waiting (a backlog grows the current file instead of
  // adding one file per cycle). Signals close one after another so files
  // rotated in the same cycle keep a deterministic send order.
  async rotateForExport(): Promise<void> {
    for (const signal of SIGNALS) {
      await this.enqueue(signal, async () => {
        if (
          this.current.has(signal) &&
          !this.closed.some((file) => file.signal === signal)
        ) {
          await this.closeCurrentFile(signal);
        }
      });
    }
    await this.evict();
  }

  async closeCurrentFiles(): Promise<void> {
    for (const signal of SIGNALS) {
      await this.enqueue(signal, () => this.closeCurrentFile(signal));
    }
  }

  // Closed files in send order (oldest first).
  pendingFiles(): SpoolFile[] {
    return [...this.closed];
  }

  async deleteFile(file: SpoolFile): Promise<void> {
    const index = this.closed.indexOf(file);
    if (index >= 0) {
      this.closed.splice(index, 1);
    }
    await file.delete();
  }

  // Refresh mtimes so orphan cleanup in a sibling process never removes live files.
  touchFiles(): void {
    for (const file of [...this.current.values(), ...this.closed]) {
      file.touch();
    }
  }

  async clear(): Promise<void> {
    await Promise.all(
      SIGNALS.map((signal) =>
        this.enqueue(signal, () => this.discardCurrentFile(signal)),
      ),
    );
    const files = this.closed.splice(0);
    await Promise.all(files.map((file) => file.delete()));
  }

  private enqueue(
    signal: Signal,
    operation: () => Promise<void>,
  ): Promise<void> {
    const result = this.queues[signal].then(operation);
    this.queues[signal] = result.catch(() => undefined);
    return result;
  }

  private async closeCurrentFile(signal: Signal): Promise<void> {
    const file = this.current.get(signal);
    if (!file) {
      return;
    }
    this.current.delete(signal);
    try {
      await file.close();
      this.closed.push(file);
    } catch {
      logWarning(
        `Error writing telemetry to disk, dropping buffered ${signal}`,
      );
      await file.delete();
    }
  }

  private async discardCurrentFile(signal: Signal): Promise<void> {
    const file = this.current.get(signal);
    if (file) {
      this.current.delete(signal);
      await file.delete();
    }
  }

  private async evict(): Promise<void> {
    const deletions: Promise<void>[] = [];
    for (const file of this.closed.filter((file) => file.isExpired())) {
      logWarning(
        `Buffered ${file.signal} could not be delivered within an hour and were dropped`,
      );
      this.closed.splice(this.closed.indexOf(file), 1);
      deletions.push(file.delete());
    }
    while (this.totalSize() > this.maxSize) {
      // Prefer retaining metrics, but the size bound still applies when only metrics remain
      const oldest =
        this.closed.find((file) => file.signal !== "metrics") ?? this.closed[0];
      if (!oldest) {
        break;
      }
      logWarning(
        `Buffer size limit reached, dropping oldest buffered ${oldest.signal}`,
      );
      this.closed.splice(this.closed.indexOf(oldest), 1);
      deletions.push(oldest.delete());
    }
    await Promise.all(deletions);
  }

  private totalSize(): number {
    let total = 0;
    for (const file of [...this.closed, ...this.current.values()]) {
      total += file.storedSize;
    }
    return total;
  }
}

// One gzip stream of concatenated OTLP request payloads for a single signal,
// written through to a temp file or, as fallback, an in-memory buffer.
export class SpoolFile {
  readonly signal: Signal;
  readonly path?: string;
  firstAttemptAtMillis?: number;
  uncompressedSize = 0;
  compressedSize = 0;
  readonly gzip: Gzip;
  private readonly fileStream?: WriteStream;
  private readonly memoryChunks?: Buffer[];
  private memorySize = 0;
  private streamError?: Error;
  private readonly closedPromise: Promise<void>;

  constructor(signal: Signal, tempDir?: string) {
    this.signal = signal;
    this.gzip = createGzip();
    let closeTarget: Gzip | WriteStream;
    let closeEvent: string;
    if (tempDir === undefined) {
      const chunks: Buffer[] = [];
      this.memoryChunks = chunks;
      this.gzip.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        this.memorySize += chunk.length;
      });
      closeTarget = this.gzip;
      closeEvent = "end";
    } else {
      this.path = join(tempDir, `apitally-${randomUUID()}.gz`);
      // A synchronous exclusive open surfaces creation errors at the append that caused them
      const fd = openSync(this.path, "wx", 0o600);
      this.fileStream = createWriteStream(this.path, { fd });
      this.gzip.pipe(this.fileStream);
      closeTarget = this.fileStream;
      closeEvent = "close";
    }
    const streams: (Gzip | WriteStream)[] = this.fileStream
      ? [this.gzip, this.fileStream]
      : [this.gzip];
    this.closedPromise = new Promise((resolve, reject) => {
      closeTarget.once(closeEvent, resolve);
      for (const stream of streams) {
        stream.once("error", reject);
      }
    });
    // A stream error may fire with no operation awaiting it; it invalidates the file on the next operation
    this.closedPromise.catch(() => undefined);
    for (const stream of streams) {
      stream.on("error", (error: Error) => {
        this.streamError ??= error;
      });
    }
  }

  write(payload: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.streamError) {
        reject(this.streamError);
        return;
      }
      this.gzip.write(payload, (error) => {
        const failure = error ?? this.streamError;
        if (failure) {
          reject(failure);
        } else {
          this.uncompressedSize += payload.length;
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.streamError) {
      throw this.streamError;
    }
    this.gzip.end();
    await this.closedPromise;
    this.compressedSize = this.storedSize;
  }

  get storedSize(): number {
    return this.fileStream ? this.fileStream.bytesWritten : this.memorySize;
  }

  markAttempt(): void {
    this.firstAttemptAtMillis ??= performance.now();
  }

  isExpired(): boolean {
    return (
      this.firstAttemptAtMillis !== undefined &&
      performance.now() - this.firstAttemptAtMillis >
        MAX_RETRY_TIME_AFTER_FIRST_ATTEMPT_MILLIS
    );
  }

  touch(): void {
    if (this.path) {
      try {
        const now = new Date();
        utimesSync(this.path, now, now);
      } catch {
        // The file may already be gone; orphan cleanup only targets stale files
      }
    }
  }

  readStoredBytes(): Promise<Buffer> {
    if (this.path) {
      return readFile(this.path);
    }
    return Promise.resolve(Buffer.concat(this.memoryChunks ?? []));
  }

  async delete(): Promise<void> {
    this.gzip.destroy();
    this.fileStream?.destroy();
    if (this.path) {
      await unlink(this.path).catch(() => undefined);
    }
  }
}

function isTempDirWritable(tempDir: string): boolean {
  const probePath = join(tempDir, `apitally-${randomUUID()}.gz`);
  try {
    writeFileSync(probePath, "", { flag: "wx", mode: 0o600 });
    unlinkSync(probePath);
    return true;
  } catch {
    return false;
  }
}

// Best-effort removal of spool files left behind by dead processes. Live
// processes refresh their files' mtimes every export cycle, keeping them newer
// than the cutoff.
function cleanupOrphanedFiles(tempDir: string): void {
  const cutoff = Date.now() - MAX_UNTOUCHED_FILE_AGE_MILLIS;
  try {
    for (const name of readdirSync(tempDir)) {
      if (!SPOOL_FILE_NAME_PATTERN.test(name)) {
        continue;
      }
      try {
        const filePath = join(tempDir, name);
        if (statSync(filePath).mtimeMs < cutoff) {
          unlinkSync(filePath);
        }
      } catch {
        // Another process may have removed the file first
      }
    }
  } catch {
    // Reading the temp dir is best-effort
  }
}
