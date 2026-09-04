import { gunzipSync } from "node:zlib";
import type { AnyValueMap } from "@opentelemetry/api-logs";
import { MAX_BODY_SIZE } from "./bodyCapture.js";

export const VALIDATION_ERROR_EVENT_NAME = "apitally.request.validation_error";

const MAX_GROUPS = 100;
const MAX_CONSUMER_LENGTH = 128;
const MAX_PATH_LENGTH = 2_000;
const MAX_SOURCE_LENGTH = 32;
const MAX_FIELD_LENGTH = 2_048;
const MAX_MESSAGE_LENGTH = 2_048;
const MAX_TYPE_LENGTH = 128;
const MAX_COUNT = 2 ** 32 - 1;

const SOURCE_ALIASES: Record<string, string> = {
  body: "body",
  query: "query",
  path: "path",
  header: "header",
  cookie: "cookie",
  querystring: "query",
  params: "path",
  path_params: "path",
  headers: "header",
  cookies: "cookie",
};

export type ValidationErrorDetail = {
  source: string;
  field: string;
  message: string;
  type: string;
};

type ValidationErrorGroup = ValidationErrorDetail & {
  consumer?: string;
  method: string;
  path: string;
  count: number;
};

let validationErrorGroups = new Map<string, ValidationErrorGroup>();

export function isValidationResponseStatus(statusCode: number): boolean {
  return statusCode === 400 || statusCode === 422;
}

export function addValidationErrors(
  consumer: string | undefined,
  method: string,
  path: string,
  details: ValidationErrorDetail[],
): void {
  method = method.toUpperCase();
  if (method === "OPTIONS" || !path) {
    return;
  }
  for (const detail of details) {
    const group: ValidationErrorGroup = {
      method,
      path: path.slice(0, MAX_PATH_LENGTH),
      source: detail.source.slice(0, MAX_SOURCE_LENGTH),
      field: detail.field.slice(0, MAX_FIELD_LENGTH),
      message: detail.message.slice(0, MAX_MESSAGE_LENGTH),
      type: detail.type.slice(0, MAX_TYPE_LENGTH),
      count: 1,
    };
    if (consumer !== undefined) {
      group.consumer = consumer.slice(0, MAX_CONSUMER_LENGTH);
    }
    const key = [
      group.consumer ?? "",
      group.method,
      group.path,
      group.source,
      group.field,
      group.message,
      group.type,
    ].join("\0");
    const existing = validationErrorGroups.get(key);
    if (existing) {
      existing.count = Math.min(existing.count + 1, MAX_COUNT);
    } else if (validationErrorGroups.size < MAX_GROUPS) {
      validationErrorGroups.set(key, group);
    }
  }
}

export function drainValidationErrors(): AnyValueMap[] {
  const groups = validationErrorGroups;
  validationErrorGroups = new Map();
  return [...groups.values()];
}

export function resetValidationErrors(): void {
  validationErrorGroups = new Map();
}

export function normalizeSource(source: unknown): string {
  return typeof source === "string" ? (SOURCE_ALIASES[source.toLowerCase()] ?? "") : "";
}

// Zod, Standard Schema, and TypeBox issues share this shape. A Standard Schema
// path segment may be an object carrying the key; a TypeBox path is a JSON pointer.
export function formatIssues(issues: unknown, source = ""): ValidationErrorDetail[] {
  if (!Array.isArray(issues)) {
    return [];
  }
  const details: ValidationErrorDetail[] = [];
  for (const issue of issues) {
    if (!isRecord(issue) || typeof issue.message !== "string") {
      continue;
    }
    const path = Array.isArray(issue.path)
      ? issue.path
      : typeof issue.path === "string"
        ? issue.path.split("/").filter(Boolean)
        : [];
    details.push({
      source,
      field: path
        .map((segment: unknown) => (isRecord(segment) ? segment.key : segment))
        .filter((segment) => typeof segment === "string" || typeof segment === "number")
        .join("."),
      message: issue.message,
      type: typeof issue.code === "string" ? issue.code : "",
    });
  }
  return details;
}

// zod 3 serializes issues as `error.issues`; zod 4 hides them as a JSON string
// in `error.message`.
export function extractZodValidationErrors(body: unknown): ValidationErrorDetail[] {
  if (!isRecord(body)) {
    return [];
  }
  const error = isRecord(body.error) ? body.error : undefined;
  let issues = body.issues ?? error?.issues;
  if (issues === undefined && error?.name === "ZodError" && typeof error.message === "string") {
    try {
      issues = JSON.parse(error.message);
    } catch {
      return [];
    }
  }
  return formatIssues(issues);
}

export function parseJsonResponseBody(body: Buffer | undefined, contentEncoding: unknown): unknown {
  if (!body) {
    return undefined;
  }
  try {
    const encoding =
      typeof contentEncoding === "string" ? contentEncoding.trim().toLowerCase() : "";
    if (encoding === "gzip") {
      return JSON.parse(gunzipSync(body, { maxOutputLength: MAX_BODY_SIZE }).toString());
    }
    if (encoding === "" || encoding === "identity") {
      return JSON.parse(body.toString());
    }
  } catch {
    // A body that cannot be decoded as JSON carries no recognizable validation details.
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
