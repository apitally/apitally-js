import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readFile,
  unlinkSync,
  writeFileSync,
  WriteStream,
} from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip, Gzip } from "node:zlib";

const TEMP_DIR = join(tmpdir(), "apitally");

export function checkWritableFs() {
  try {
    mkdirSync(TEMP_DIR, { recursive: true });
    const testPath = join(TEMP_DIR, `test_${randomUUID()}`);
    writeFileSync(testPath, "test");
    unlinkSync(testPath);
    return true;
  } catch (error) {
    return false;
  }
}

export default class TempGzipFile {
  public uuid: string;
  private filePath: string;
  private gzip: Gzip;
  private writeStream: WriteStream;
  private readyPromise: Promise<void>;
  private closedPromise: Promise<void>;

  constructor(name: string) {
    mkdirSync(TEMP_DIR, { recursive: true });
    this.uuid = randomUUID();
    this.filePath = join(TEMP_DIR, `${name}_${this.uuid}.gz`);
    this.writeStream = createWriteStream(this.filePath);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.writeStream.once("ready", resolve);
      this.writeStream.once("error", reject);
    });
    this.closedPromise = new Promise<void>((resolve, reject) => {
      this.writeStream.once("close", resolve);
      this.writeStream.once("error", reject);
    });
    this.gzip = createGzip();
    this.gzip.pipe(this.writeStream);
  }

  get size() {
    return this.writeStream.bytesWritten;
  }

  async writeLine(data: Buffer) {
    await this.readyPromise;
    return new Promise<void>((resolve, reject) => {
      this.gzip.write(Buffer.concat([data, Buffer.from("\n")]), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async writeLines(lines: Buffer[]) {
    if (lines.length === 0) return;
    await this.readyPromise;
    // Batch every line into a single gzip.write so the caller awaits once
    // per drain instead of once per item — drops O(N) awaits/syscalls down
    // to one, which is the difference between sustaining ~7 req/s and
    // sustaining thousands.
    const parts: Buffer[] = [];
    const newline = Buffer.from("\n");
    for (const line of lines) {
      parts.push(line, newline);
    }
    const combined = Buffer.concat(parts);
    return new Promise<void>((resolve, reject) => {
      this.gzip.write(combined, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async getContent() {
    return new Promise<Buffer>((resolve, reject) => {
      readFile(this.filePath, (error, data) => {
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      });
    });
  }

  async close() {
    await new Promise<void>((resolve) => {
      this.gzip.end(() => {
        resolve();
      });
    });
    await this.closedPromise;
  }

  async delete() {
    await this.close();
    await unlink(this.filePath);
  }
}
