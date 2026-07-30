import type { Exception } from "@opentelemetry/api";
import { getServerSpan } from "./context.js";
import { logDebug } from "./logger.js";

export function captureException(error: unknown): void {
  try {
    const span = getServerSpan();
    if (!span?.isRecording()) {
      return;
    }
    span.recordException(coerceToException(error));
  } catch (captureError) {
    logDebug(`Error capturing exception: ${String(captureError)}`);
  }
}

export function coerceToException(error: unknown): Exception {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    if (
      error.name === "Error" &&
      error.constructor.name !== "" &&
      error.constructor.name !== error.name
    ) {
      return {
        ...error,
        message: error.message,
        name: error.constructor.name,
        stack: error.stack,
      };
    }
    return error;
  }
  if (typeof error === "object" && error !== null) {
    return error as Exception;
  }
  return String(error);
}
