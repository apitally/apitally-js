import type { AnyValueMap } from "@opentelemetry/api-logs";
import { coerceToException } from "./exceptions.js";

export const SERVER_ERROR_EVENT_NAME = "apitally.request.server_error";

const MAX_GROUPS = 100;
const MAX_CONSUMER_LENGTH = 128;
const MAX_PATH_LENGTH = 2_000;
const MAX_TYPE_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 2_048;
const MAX_STACKTRACE_LENGTH = 65_536;
const MAX_COUNT = 2 ** 32 - 1;
const MESSAGE_TRUNCATION_SUFFIX = "... (truncated)";
const STACKTRACE_TRUNCATION_SUFFIX = "\n... (truncated) ...";

type ServerErrorGroup = {
  consumer?: string;
  method: string;
  path: string;
  type: string;
  message: string;
  stacktrace: string;
  count: number;
  sentry_event_id?: string;
};

let serverErrorGroups = new Map<string, ServerErrorGroup>();

export function addServerError(
  consumer: string | undefined,
  method: string,
  path: string,
  error: unknown,
  sentryEventId: string | undefined,
): void {
  method = method.toUpperCase();
  if (method === "OPTIONS" || !path) {
    return;
  }
  const exception = coerceToException(error);
  const { name, message, stack } =
    typeof exception === "string"
      ? { name: "", message: exception, stack: "" }
      : (exception as { name?: unknown; message?: unknown; stack?: unknown });
  const group: ServerErrorGroup = {
    method,
    path: path.slice(0, MAX_PATH_LENGTH),
    type: String(name ?? "").slice(0, MAX_TYPE_LENGTH),
    message: formatMessage(message),
    stacktrace: formatStacktrace(stack),
    count: 1,
  };
  if (consumer !== undefined) {
    group.consumer = consumer.slice(0, MAX_CONSUMER_LENGTH);
  }
  if (sentryEventId !== undefined) {
    group.sentry_event_id = sentryEventId;
  }
  const key = [
    group.consumer ?? "",
    group.method,
    group.path,
    group.type,
    group.message,
    group.stacktrace,
  ].join("\0");
  const existing = serverErrorGroups.get(key);
  if (existing) {
    existing.count = Math.min(existing.count + 1, MAX_COUNT);
    existing.sentry_event_id = group.sentry_event_id ?? existing.sentry_event_id;
  } else if (serverErrorGroups.size < MAX_GROUPS) {
    serverErrorGroups.set(key, group);
  }
}

export function drainServerErrors(): AnyValueMap[] {
  const groups = serverErrorGroups;
  serverErrorGroups = new Map();
  return [...groups.values()];
}

export function resetServerErrors(): void {
  serverErrorGroups = new Map();
}

function formatMessage(message: unknown): string {
  const text = String(message ?? "").trim();
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return text;
  }
  return (
    text.slice(0, MAX_MESSAGE_LENGTH - MESSAGE_TRUNCATION_SUFFIX.length) + MESSAGE_TRUNCATION_SUFFIX
  );
}

// The error line and innermost frames come first in a JS stack, so the head is kept.
function formatStacktrace(stack: unknown): string {
  const text = typeof stack === "string" ? stack.trim() : "";
  if (text.length <= MAX_STACKTRACE_LENGTH) {
    return text;
  }
  const cutoff = MAX_STACKTRACE_LENGTH - STACKTRACE_TRUNCATION_SUFFIX.length;
  const lines: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    if (length + line.length + 1 > cutoff) {
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n") + STACKTRACE_TRUNCATION_SUFFIX;
}
