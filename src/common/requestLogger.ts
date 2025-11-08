import AsyncLock from "async-lock";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSentryEventId } from "./sentry.js";
import {
  truncateExceptionMessage,
  truncateExceptionStackTrace,
} from "./serverErrorCounter.js";
import TempGzipFile from "./tempGzipFile.js";

const MAX_BODY_SIZE = 50_000; // 50 KB (uncompressed)
const MAX_FILE_SIZE = 1_000_000; // 1 MB (compressed)
const MAX_FILES = 50;
const MAX_PENDING_WRITES = 100;
const MAX_LOG_MSG_LENGTH = 2048;
const BODY_TOO_LARGE = Buffer.from("<body too large>");
const BODY_MASKED = Buffer.from("<masked>");
const MASKED = "******";
const ALLOWED_CONTENT_TYPES = [
  "application/json",
  "application/x-ndjson",
  "application/ld+json",
  "application/problem+json",
  "application/vnd.api+json",
  "text/plain",
  "text/html",
];
const EXCLUDE_PATH_PATTERNS = [
  /\/_?healthz?$/i,
  /\/_?health[_-]?checks?$/i,
  /\/_?heart[_-]?beats?$/i,
  /\/ping$/i,
  /\/ready$/i,
  /\/live$/i,
];
const EXCLUDE_USER_AGENT_PATTERNS = [
  /health[-_ ]?check/i,
  /microsoft-azure-application-lb/i,
  /googlehc/i,
  /kube-probe/i,
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
const MASK_BODY_FIELD_PATTERNS = [
  /password/i,
  /pwd/i,
  /token/i,
  /secret/i,
  /auth/i,
  /card[-_ ]?number/i,
  /ccv/i,
  /ssn/i,
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

export type LogRecord = {
  timestamp: number;
  logger?: string;
  level: string;
  message: string;
};

export type RequestLoggingConfig = {
  enabled: boolean;
  logQueryParams: boolean;
  logRequestHeaders: boolean;
  logRequestBody: boolean;
  logResponseHeaders: boolean;
  logResponseBody: boolean;
  logException: boolean;
  captureLogs: boolean;
  maskQueryParams: RegExp[];
  maskHeaders: RegExp[];
  maskBodyFields: RegExp[];
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
  logException: true,
  captureLogs: false,
  maskQueryParams: [],
  maskHeaders: [],
  maskBodyFields: [],
  excludePaths: [],
};

type RequestLogItem = {
  uuid: string;
  request: Request;
  response: Response;
  exception?: {
    type: string;
    message: string;
    stacktrace: string;
    sentryEventId?: string;
  };
  logs?: LogRecord[];
};

export default class RequestLogger {
  public config: RequestLoggingConfig;
  public enabled: boolean;
  public suspendUntil: number | null = null;
  private pendingWrites: RequestLogItem[] = [];
  private currentFile: TempGzipFile | null = null;
  private files: TempGzipFile[] = [];
  private maintainIntervalId?: NodeJS.Timeout;
  private lock = new AsyncLock();

  constructor(config?: Partial<RequestLoggingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.enabled = this.config.enabled && checkWritableFs();

    if (this.enabled) {
      this.maintainIntervalId = setInterval(() => {
        this.maintain();
      }, 1000);
    }
  }

  get maxBodySize() {
    return MAX_BODY_SIZE;
  }

  private shouldExcludePath(urlPath: string) {
    const patterns = [...this.config.excludePaths, ...EXCLUDE_PATH_PATTERNS];
    return matchPatterns(urlPath, patterns);
  }

  private shouldExcludeUserAgent(userAgent?: string) {
    return userAgent
      ? matchPatterns(userAgent, EXCLUDE_USER_AGENT_PATTERNS)
      : false;
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

  private shouldMaskBodyField(name: string) {
    const patterns = [
      ...this.config.maskBodyFields,
      ...MASK_BODY_FIELD_PATTERNS,
    ];
    return matchPatterns(name, patterns);
  }

  private hasSupportedContentType(headers: [string, string][]) {
    const contentType = headers.find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];
    return this.isSupportedContentType(contentType);
  }

  private hasJsonContentType(headers: [string, string][]) {
    const contentType = headers.find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];
    return contentType ? /\bjson\b/i.test(contentType) : null;
  }

  public isSupportedContentType(contentType?: string | null) {
    return (
      typeof contentType === "string" &&
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

  private maskBody(data: any): any {
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const result: any = {};
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "string" && this.shouldMaskBodyField(key)) {
          result[key] = MASKED;
        } else {
          result[key] = this.maskBody(value);
        }
      }
      return result;
    }
    if (Array.isArray(data)) {
      return data.map((item) => this.maskBody(item));
    }
    return data;
  }

  private applyMasking(item: RequestLogItem) {
    // Apply user-provided maskRequestBodyCallback function
    if (
      this.config.maskRequestBodyCallback &&
      item.request.body &&
      item.request.body !== BODY_TOO_LARGE
    ) {
      try {
        const maskedBody = this.config.maskRequestBodyCallback(item.request);
        item.request.body = maskedBody ?? BODY_MASKED;
      } catch {
        item.request.body = undefined;
      }
    }

    // Apply user-provided maskResponseBodyCallback function
    if (
      this.config.maskResponseBodyCallback &&
      item.response.body &&
      item.response.body !== BODY_TOO_LARGE
    ) {
      try {
        const maskedBody = this.config.maskResponseBodyCallback(
          item.request,
          item.response,
        );
        item.response.body = maskedBody ?? BODY_MASKED;
      } catch {
        item.response.body = undefined;
      }
    }

    // Check request and response body sizes
    if (item.request.body && item.request.body.length > MAX_BODY_SIZE) {
      item.request.body = BODY_TOO_LARGE;
    }
    if (item.response.body && item.response.body.length > MAX_BODY_SIZE) {
      item.response.body = BODY_TOO_LARGE;
    }

    // Mask request and response body fields
    for (const key of ["request", "response"] as const) {
      const bodyData = item[key].body;
      if (
        !bodyData ||
        bodyData === BODY_TOO_LARGE ||
        bodyData === BODY_MASKED
      ) {
        continue;
      }

      const headers = item[key].headers;
      const hasJsonContent = this.hasJsonContentType(headers);
      if (hasJsonContent === null || hasJsonContent) {
        try {
          const parsedBody = JSON.parse(bodyData.toString());
          const maskedBody = this.maskBody(parsedBody);
          item[key].body = Buffer.from(JSON.stringify(maskedBody));
        } catch {
          // If parsing fails, leave body as is
        }
      }
    }

    // Mask request and response headers
    item.request.headers = this.config.logRequestHeaders
      ? this.maskHeaders(item.request.headers)
      : [];
    item.response.headers = this.config.logResponseHeaders
      ? this.maskHeaders(item.response.headers)
      : [];

    // Mask query params
    const url = new URL(item.request.url);
    url.search = this.config.logQueryParams
      ? this.maskQueryParams(url.search)
      : "";
    item.request.url = url.toString();

    return item;
  }

  logRequest(
    request: Request,
    response: Response,
    error?: Error,
    logs?: LogRecord[],
  ) {
    if (!this.enabled || this.suspendUntil !== null) return;

    const url = new URL(request.url);
    const path = request.path ?? url.pathname;
    const userAgent = request.headers.find(
      ([k]) => k.toLowerCase() === "user-agent",
    )?.[1];

    if (
      this.shouldExcludePath(path) ||
      this.shouldExcludeUserAgent(userAgent) ||
      (this.config.excludeCallback?.(request, response) ?? false)
    ) {
      return;
    }

    if (
      !this.config.logRequestBody ||
      !this.hasSupportedContentType(request.headers)
    ) {
      request.body = undefined;
    }
    if (
      !this.config.logResponseBody ||
      !this.hasSupportedContentType(response.headers)
    ) {
      response.body = undefined;
    }

    if (request.size !== undefined && request.size < 0) {
      request.size = undefined;
    }
    if (response.size !== undefined && response.size < 0) {
      response.size = undefined;
    }

    const item: RequestLogItem = {
      uuid: randomUUID(),
      request: request,
      response: response,
      exception:
        error && this.config.logException
          ? {
              type: error.name,
              message: truncateExceptionMessage(error.message),
              stacktrace: truncateExceptionStackTrace(error.stack || ""),
              sentryEventId: getSentryEventId(),
            }
          : undefined,
    };

    if (logs && logs.length > 0) {
      item.logs = logs.map((log) => ({
        timestamp: log.timestamp,
        logger: log.logger,
        level: log.level,
        message: truncateLogMessage(log.message),
      }));
    }
    this.pendingWrites.push(item);

    if (this.pendingWrites.length > MAX_PENDING_WRITES) {
      this.pendingWrites.shift();
    }
  }

  async writeToFile() {
    if (!this.enabled || this.pendingWrites.length === 0) {
      return;
    }
    return this.lock.acquire("file", async () => {
      if (!this.currentFile) {
        this.currentFile = new TempGzipFile();
      }
      while (this.pendingWrites.length > 0) {
        let item = this.pendingWrites.shift();
        if (item) {
          item = this.applyMasking(item);

          const finalItem = {
            uuid: item.uuid,
            request: skipEmptyValues(item.request),
            response: skipEmptyValues(item.response),
            exception: item.exception,
            logs: item.logs,
          };

          // Set up body serialization for JSON
          [finalItem.request.body, finalItem.response.body].forEach((body) => {
            if (body) {
              // @ts-expect-error Override Buffer's default JSON serialization
              body.toJSON = function () {
                return this.toString("base64");
              };
            }
          });

          await this.currentFile.writeLine(
            Buffer.from(JSON.stringify(finalItem)),
          );
        }
      }
    });
  }

  getFile() {
    return this.files.shift();
  }

  retryFileLater(file: TempGzipFile) {
    this.files.unshift(file);
  }

  async rotateFile() {
    return this.lock.acquire("file", async () => {
      if (this.currentFile) {
        await this.currentFile.close();
        this.files.push(this.currentFile);
        this.currentFile = null;
      }
    });
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
    | Record<string, string | string[] | number | undefined>
    | undefined,
) {
  if (!headers) {
    return [];
  }
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

function truncateLogMessage(msg: string) {
  if (msg.length > MAX_LOG_MSG_LENGTH) {
    const suffix = "... (truncated)";
    return msg.slice(0, MAX_LOG_MSG_LENGTH - suffix.length) + suffix;
  }
  return msg;
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
