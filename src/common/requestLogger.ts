import { Buffer } from "buffer";
import { randomUUID } from "crypto";
import { unlinkSync, writeFileSync } from "fs";
import { IncomingHttpHeaders, OutgoingHttpHeaders } from "http";
import { tmpdir } from "os";
import { join } from "path";

import TempGzipFile from "./tempGzipFile.js";

const MAX_BODY_SIZE = 50_000; // 50 KB (uncompressed)
const MAX_FILE_SIZE = 1_000_000; // 1 MB (compressed)
const MAX_FILES = 50;
const MAX_PENDING_WRITES = 100;
const BODY_TOO_LARGE = Buffer.from("<body too large>");
const BODY_MASKED = Buffer.from("<masked>");
const MASKED = "******";
const ALLOWED_CONTENT_TYPES = ["application/json", "text/plain"];
const EXCLUDE_PATH_PATTERNS = [
  /\/_?healthz?$/i,
  /\/_?health[_-]?checks?$/i,
  /\/_?heart[_-]?beats?$/i,
  /\/ping$/i,
  /\/ready$/i,
  /\/live$/i,
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
  maskRequestBodyCallback?: (request: Request) => Buffer | null | undefined;
  maskResponseBodyCallback?: (
    request: Request,
    response: Response,
  ) => Buffer | null | undefined;
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

export default class RequestLogger {
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

  private maskQueryParams(search: string) {
    const params = new URLSearchParams(search);
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
    url.search = this.config.logQueryParams
      ? this.maskQueryParams(url.search)
      : "";
    request.url = url.toString();

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
            this.config.maskRequestBodyCallback(request) ?? BODY_MASKED;
          if (request.body.length > MAX_BODY_SIZE) {
            request.body = BODY_TOO_LARGE;
          }
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
            this.config.maskResponseBodyCallback(request, response) ??
            BODY_MASKED;
          if (response.body.length > MAX_BODY_SIZE) {
            response.body = BODY_TOO_LARGE;
          }
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
    [item.request.body, item.response.body].forEach((body) => {
      if (body) {
        // @ts-expect-error Different return type
        body.toJSON = function () {
          return this.toString("base64");
        };
      }
    });
    this.pendingWrites.push(JSON.stringify(item));

    if (this.pendingWrites.length > MAX_PENDING_WRITES) {
      this.pendingWrites.shift();
    }
  }

  async writeToFile() {
    if (!this.enabled || this.pendingWrites.length === 0) {
      return;
    }
    if (!this.currentFile) {
      this.currentFile = new TempGzipFile();
    }
    while (this.pendingWrites.length > 0) {
      const item = this.pendingWrites.shift();
      if (item) {
        await this.currentFile.writeLine(Buffer.from(item));
      }
    }
  }

  getFile() {
    return this.files.shift();
  }

  retryFileLater(file: TempGzipFile) {
    this.files.unshift(file);
  }

  async rotateFile() {
    if (this.currentFile) {
      await this.currentFile.close();
      this.files.push(this.currentFile);
      this.currentFile = null;
    }
  }

  async maintain() {
    await this.writeToFile();
    if (this.currentFile && this.currentFile.size > MAX_FILE_SIZE) {
      await this.rotateFile();
    }
    while (this.files.length > MAX_FILES) {
      const file = this.files.shift();
      file?.delete();
    }
    if (this.suspendUntil !== null && this.suspendUntil < Date.now()) {
      this.suspendUntil = null;
    }
  }

  async clear() {
    this.pendingWrites = [];
    await this.rotateFile();
    this.files.forEach((file) => {
      file.delete();
    });
    this.files = [];
  }

  async close() {
    this.enabled = false;
    await this.clear();
    if (this.maintainIntervalId) {
      clearInterval(this.maintainIntervalId);
    }
  }
}

export function convertHeaders(
  headers:
    | Headers
    | IncomingHttpHeaders
    | OutgoingHttpHeaders
    | Record<string, string | string[] | number | undefined>,
) {
  if (headers instanceof Headers) {
    return Array.from(headers.entries());
  }
  return Object.entries(headers).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }
    if (Array.isArray(value)) {
      return value.map((v) => [key, v]);
    }
    return [[key, value.toString()]];
  }) as [string, string][];
}

export function convertBody(body: any, contentType?: string | null) {
  if (!body || !contentType) {
    return;
  }
  try {
    if (contentType.startsWith("application/json")) {
      if (isValidJsonString(body)) {
        return Buffer.from(body);
      } else {
        return Buffer.from(JSON.stringify(body));
      }
    }
    if (contentType.startsWith("text/") && typeof body === "string") {
      return Buffer.from(body);
    }
  } catch (error) {
    return;
  }
}

function isValidJsonString(body: any) {
  if (typeof body !== "string") {
    return false;
  }
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
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
      if (v == null || Number.isNaN(v)) return false;
      if (Array.isArray(v) || Buffer.isBuffer(v) || typeof v === "string") {
        return v.length > 0;
      }
      return true;
    }),
  ) as Partial<T>;
}

function checkWritableFs() {
  try {
    const testPath = join(tmpdir(), `apitally-${randomUUID()}`);
    writeFileSync(testPath, "test");
    unlinkSync(testPath);
    return true;
  } catch (error) {
    return false;
  }
}
