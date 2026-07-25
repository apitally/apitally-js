import { fileURLToPath } from "node:url";
import {
  type Attributes,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { logDebug } from "./logger.js";
import { coerceToException } from "./spanProcessor.js";

const STACK_FRAME_PATTERN = /at (?:.*\()?(.*?):(\d+):\d+\)?$/;

export function instrument<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result;
export function instrument<Args extends unknown[], Result>(
  name: string,
  fn: (...args: Args) => Result,
): (...args: Args) => Result;
export function instrument(
  nameOrFn: string | ((...args: unknown[]) => unknown),
  fnWhenNamed?: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  const fn =
    typeof nameOrFn === "function"
      ? nameOrFn
      : (fnWhenNamed as (...args: unknown[]) => unknown);
  const spanName =
    typeof nameOrFn === "string" ? nameOrFn : fn.name || "anonymous";
  const attributes: Attributes = {};
  if (fn.name) {
    attributes["code.function.name"] = fn.name;
  }
  const wrapSite = resolveWrapSite();
  if (wrapSite) {
    attributes["code.file.path"] = wrapSite.filePath;
    attributes["code.line.number"] = wrapSite.lineNumber;
  }
  return function (this: unknown, ...args: unknown[]): unknown {
    return runInsideSpan(spanName, attributes, () => fn.apply(this, args));
  };
}

export function span<Result>(name: string, fn: () => Result): Result {
  return runInsideSpan(name, undefined, fn);
}

// Function errors propagate unchanged. If span creation fails, the function
// runs without a span.
function runInsideSpan<Result>(
  name: string,
  attributes: Attributes | undefined,
  fn: () => Result,
): Result {
  let internalSpan: Span;
  try {
    internalSpan = trace
      .getTracer("apitally.otel")
      .startSpan(name, { kind: SpanKind.INTERNAL, attributes });
  } catch (error) {
    logDebug(`Error starting a manual span: ${String(error)}`);
    return fn();
  }
  let result: Result;
  try {
    result = context.with(trace.setSpan(context.active(), internalSpan), fn);
  } catch (error) {
    endSpanWithError(internalSpan, error);
    throw error;
  }
  if (isThenable(result)) {
    // Side listener on the function's own promise, which passes through
    // unchanged; neither handler rethrows, so this chain never rejects.
    result.then(
      () => endSpan(internalSpan),
      (error: unknown) => endSpanWithError(internalSpan, error),
    );
    return result;
  }
  endSpan(internalSpan);
  return result;
}

// The wrap-time call site, taken from a stack capture that starts at
// instrument's caller. An unparseable stack yields no location attributes.
function resolveWrapSite():
  | { filePath: string; lineNumber: number }
  | undefined {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, instrument);
  for (const frame of (holder.stack ?? "").split("\n")) {
    const match = STACK_FRAME_PATTERN.exec(frame);
    if (match) {
      return {
        filePath: match[1].startsWith("file://")
          ? fileURLToPath(match[1])
          : match[1],
        lineNumber: Number(match[2]),
      };
    }
  }
  return undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function endSpan(internalSpan: Span): void {
  try {
    internalSpan.end();
  } catch (error) {
    logDebug(`Error ending a manual span: ${String(error)}`);
  }
}

function endSpanWithError(internalSpan: Span, error: unknown): void {
  try {
    const exception = coerceToException(error);
    internalSpan.recordException(exception);
    internalSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: typeof exception === "string" ? exception : exception.message,
    });
    internalSpan.end();
  } catch (endError) {
    logDebug(`Error ending a manual span: ${String(endError)}`);
  }
}
