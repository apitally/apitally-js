import { Buffer } from "buffer";
import { randomUUID } from "crypto";
import { createWriteStream, readFile, unlinkSync, WriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createGzip, Gzip } from "zlib";

export default class TempGzipFile {
  public uuid: string;
  private filePath: string;
  private gzip: Gzip;
  private writeStream: WriteStream;
  private readyPromise: Promise<void>;
  private closedPromise: Promise<void>;

  constructor() {
    this.uuid = randomUUID();
    this.filePath = join(tmpdir(), `apitally-${this.uuid}.gz`);
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
    unlinkSync(this.filePath);
  }
}
