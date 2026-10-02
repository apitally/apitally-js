import type { AnyValueMap } from "@opentelemetry/api-logs";
import { coerceToException } from "./exceptions.js";

export const SERVER_ERROR_EVENT_NAME = "apitally.request.server_error";

const MAX_ERRORS = 100;
const MAX_CONSUMER_LENGTH = 128;
const MAX_PATH_LENGTH = 2_000;
const MAX_TYPE_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 2_048;
const MAX_STACKTRACE_LENGTH = 65_536;
const MESSAGE_TRUNCATION_SUFFIX = "... (truncated)";
const STACKTRACE_TRUNCATION_SUFFIX = "\n... (truncated) ...";

type ServerErrorAggregate = {
  method: string;
  path: string;
  type: string;
  message: string;
  stacktrace: string;
  sentry_event_id?: string;
  counts: Map<string | undefined, number>;
};

const SERVER_ERROR_AGGREGATES_KEY = Symbol.for("apitally.serverErrorAggregates");
const serverErrorAggregatesHolder = globalThis as Record<
  symbol,
  Map<string, ServerErrorAggregate> | undefined
>;
const serverErrorAggregates =
  serverErrorAggregatesHolder[SERVER_ERROR_AGGREGATES_KEY] ??
  new Map<string, ServerErrorAggregate>();
serverErrorAggregatesHolder[SERVER_ERROR_AGGREGATES_KEY] = serverErrorAggregates;

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
  const fields = {
    method,
    path: path.slice(0, MAX_PATH_LENGTH),
    type: String(name ?? "").slice(0, MAX_TYPE_LENGTH),
    message: formatMessage(message),
    stacktrace: formatStacktrace(stack),
  };
  const key = Object.values(fields).join("\0");
  let aggregate = serverErrorAggregates.get(key);
  if (!aggregate) {
    if (serverErrorAggregates.size >= MAX_ERRORS) {
      return;
    }
    aggregate = { ...fields, counts: new Map() };
    serverErrorAggregates.set(key, aggregate);
  }
  consumer = consumer?.slice(0, MAX_CONSUMER_LENGTH);
  aggregate.counts.set(consumer, (aggregate.counts.get(consumer) ?? 0) + 1);
  if (sentryEventId !== undefined) {
    aggregate.sentry_event_id = sentryEventId;
  }
}

export function drainServerErrors(): AnyValueMap[] {
  const aggregates = [...serverErrorAggregates.values()];
  serverErrorAggregates.clear();
  return aggregates.map(({ counts, ...fields }) => ({
    ...fields,
    counts: [...counts].map(([consumer, count]) =>
      consumer === undefined ? { count } : { consumer, count },
    ),
  }));
}

export function resetServerErrors(): void {
  serverErrorAggregates.clear();
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
