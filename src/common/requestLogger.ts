import { Buffer } from "buffer";
import { randomUUID } from "crypto";
import { createReadStream, createWriteStream, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createGzip } from "zlib";

const MAX_BODY_SIZE = 50_000; // 50 KB (uncompressed)
const MAX_FILE_SIZE = 1_000_000; // 1 MB (compressed)
const MAX_REQUESTS_IN_DEQUE = 100;
const MAX_FILES_IN_DEQUE = 50;
const BODY_TOO_LARGE = Buffer.from("<body too large>");
const BODY_MASKED = Buffer.from("<masked>");
const MASKED = "******";
const ALLOWED_CONTENT_TYPES = ["application/json", "text/plain"];
const EXCLUDE_PATH_PATTERNS = [
  /\/_?healthz?$/,
  /\/_?health[_-]?checks?$/,
  /\/_?heart[_-]?beats?$/,
  /\/ping$/,
  /\/ready$/,
  /\/live$/,
];
const MASK_QUERY_PARAM_PATTERNS = [
  /auth/i,
  /api-?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /pwd/i,
];
const MASK_HEADER_PATTERNS = [
  /auth/i,
  /api-?key/i,
  /secret/i,
  /token/i,
  /cookie/i,
];

export type Request = {
  timestamp: number;
  method: string;
  path?: string;
  url: string;
  headers: [string, string][];
  size?: number;
  consumer?: string;
  body?: Buffer;
};

export type Response = {
  statusCode: number;
  responseTime: number;
  headers: [string, string][];
  size?: number;
  body?: Buffer;
};

export type RequestLoggingConfig = {
  enabled: boolean;
  logQueryParams: boolean;
  logRequestHeaders: boolean;
  logRequestBody: boolean;
  logResponseHeaders: boolean;
  logResponseBody: boolean;
  maskQueryParams: RegExp[];
  maskHeaders: RegExp[];
  maskRequestBodyCallback?: (
    method: string,
    path: string,
    body: Buffer,
  ) => Buffer | null;
  maskResponseBodyCallback?: (
    method: string,
    path: string,
    body: Buffer,
  ) => Buffer | null;
  excludePaths: RegExp[];
  excludeCallback?: (request: Request, response: Response) => boolean;
};

const DEFAULT_CONFIG: RequestLoggingConfig = {
  enabled: false,
  logQueryParams: true,
  logRequestHeaders: false,
  logRequestBody: false,
  logResponseHeaders: true,
  logResponseBody: false,
  maskQueryParams: [],
  maskHeaders: [],
  excludePaths: [],
};

export class RequestLogger {
  public config: RequestLoggingConfig;
  public enabled: boolean;
  public suspendUntil: number | null = null;
  private pendingWrites: string[] = [];
  private currentFile: TempGzipFile | null = null;
  private files: TempGzipFile[] = [];
  private maintainIntervalId?: NodeJS.Timeout;

  constructor(config?: Partial<RequestLoggingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.enabled = this.config.enabled && checkWritableFs();
    if (this.enabled) {
      this.maintainIntervalId = setInterval(() => {
        this.maintain();
      }, 1000);
    }
  }

  private shouldExcludePath(urlPath: string) {
    const patterns = [...this.config.excludePaths, ...EXCLUDE_PATH_PATTERNS];
    return matchPatterns(urlPath, patterns);
  }

  private shouldMaskQueryParam(name: string) {
    const patterns = [
      ...this.config.maskQueryParams,
      ...MASK_QUERY_PARAM_PATTERNS,
    ];
    return matchPatterns(name, patterns);
  }

  private shouldMaskHeader(name: string) {
    const patterns = [...this.config.maskHeaders, ...MASK_HEADER_PATTERNS];
    return matchPatterns(name, patterns);
  }

  private hasSupportedContentType(headers: [string, string][]) {
    const contentType = headers.find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];
    return (
      contentType !== undefined &&
      ALLOWED_CONTENT_TYPES.some((t) => contentType.startsWith(t))
    );
  }

  private maskQueryParams(url: URL) {
    const params = new URLSearchParams(url.search);
    for (const [key] of params) {
      if (this.shouldMaskQueryParam(key)) {
        params.set(key, MASKED);
      }
    }
    return params.toString();
  }

  private maskHeaders(headers: [string, string][]): [string, string][] {
    return headers.map(([k, v]) => [k, this.shouldMaskHeader(k) ? MASKED : v]);
  }

  logRequest(request: Request, response: Response) {
    if (!this.enabled || this.suspendUntil !== null) return;

    const url = new URL(request.url);
    const path = request.path ?? url.pathname;

    if (
      this.shouldExcludePath(path) ||
      (this.config.excludeCallback?.(request, response) ?? false)
    ) {
      return;
    }

    // Process query params
    if (this.config.logQueryParams) {
      const maskedQuery = this.maskQueryParams(url);
      url.search = maskedQuery;
      request.url = url.toString();
    }

    // Process headers
    request.headers = this.config.logRequestHeaders
      ? this.maskHeaders(request.headers)
      : [];
    response.headers = this.config.logResponseHeaders
      ? this.maskHeaders(response.headers)
      : [];

    // Process request body
    if (
      !this.config.logRequestBody ||
      !this.hasSupportedContentType(request.headers)
    ) {
      request.body = undefined;
    } else if (request.body) {
      if (request.body.length > MAX_BODY_SIZE) {
        request.body = BODY_TOO_LARGE;
      } else if (this.config.maskRequestBodyCallback) {
        try {
          request.body =
            this.config.maskRequestBodyCallback(
              request.method,
              path,
              request.body,
            ) ?? BODY_MASKED;
        } catch {
          request.body = undefined;
        }
      }
    }

    // Process response body
    if (
      !this.config.logResponseBody ||
      !this.hasSupportedContentType(response.headers)
    ) {
      response.body = undefined;
    } else if (response.body) {
      if (response.body.length > MAX_BODY_SIZE) {
        response.body = BODY_TOO_LARGE;
      } else if (this.config.maskResponseBodyCallback) {
        try {
          response.body =
            this.config.maskResponseBodyCallback(
              request.method,
              path,
              response.body,
            ) ?? BODY_MASKED;
        } catch {
          response.body = undefined;
        }
      }
    }

    const item = {
      uuid: randomUUID(),
      request: skipEmptyValues(request),
      response: skipEmptyValues(response),
    };
    this.pendingWrites.push(JSON.stringify(item));
    if (this.pendingWrites.length > MAX_REQUESTS_IN_DEQUE) {
      this.pendingWrites.shift();
    }
  }

  writeToFile() {
    if (!this.enabled || this.pendingWrites.length === 0) {
      return;
    }
    if (!this.currentFile) {
      this.currentFile = new TempGzipFile();
    }
    while (this.pendingWrites.length > 0) {
      const item = this.pendingWrites.shift();
      if (item) {
        this.currentFile.writeLine(Buffer.from(item));
      }
    }
  }

  getFile() {
    return this.files.shift();
  }

  retryFileLater(file: TempGzipFile) {
    this.files.unshift(file);
  }

  rotateFile() {
    if (this.currentFile) {
      this.currentFile.close();
      this.files.push(this.currentFile);
      this.currentFile = null;
    }
  }

  maintain() {
    if (this.currentFile && this.currentFile.size > MAX_FILE_SIZE) {
      this.rotateFile();
    }
    while (this.files.length > MAX_FILES_IN_DEQUE) {
      const file = this.files.shift();
      file?.delete();
    }
    if (this.suspendUntil !== null && this.suspendUntil < Date.now()) {
      this.suspendUntil = null;
    }
  }

  clear() {
    this.pendingWrites = [];
    this.rotateFile();
    for (const file of this.files) {
      file.delete();
    }
    this.files = [];
  }

  close() {
    this.enabled = false;
    this.clear();
    if (this.maintainIntervalId) {
      clearInterval(this.maintainIntervalId);
    }
  }
}

class TempGzipFile {
  public uuid: string;
  private filePath: string;
  private gzipStream: ReturnType<typeof createGzip>;
  private writeStream: ReturnType<typeof createWriteStream>;

  constructor() {
    this.uuid = randomUUID();
    this.filePath = join(tmpdir(), `apitally-${this.uuid}.gz`);
    this.writeStream = createWriteStream(this.filePath);
    this.gzipStream = createGzip();
    this.gzipStream.pipe(this.writeStream);
  }

  get size() {
    return this.writeStream.bytesWritten;
  }

  writeLine(data: Buffer) {
    this.gzipStream.write(Buffer.concat([data, Buffer.from("\n")]));
  }

  getReadStream() {
    return createReadStream(this.filePath);
  }

  close() {
    this.gzipStream.end();
    this.writeStream.end();
  }

  delete() {
    this.close();
    try {
      unlinkSync(this.filePath);
    } catch {
      // Ignore errors when deleting file
    }
  }
}

function matchPatterns(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => {
    return pattern.test(value);
  });
}

function skipEmptyValues<T extends Record<string, any>>(data: T) {
  return Object.fromEntries(
    Object.entries(data).filter(([_, v]) => {
      if (v == null) return false;
      if (Array.isArray(v) || Buffer.isBuffer(v) || typeof v === "string") {
        return v.length > 0;
      }
      return true;
    }),
  ) as Partial<T>;
}

function checkWritableFs() {
  const testPath = join(tmpdir(), `apitally-${randomUUID()}`);
  try {
    createWriteStream(testPath).end();
    unlinkSync(testPath);
    return true;
  } catch (error) {
    return false;
  }
}
