import type { AttributeValue, Span } from "@opentelemetry/api";
import { getRequestRecord, getServerSpan, type RequestRecord } from "./context.js";
import { logDebug } from "./logger.js";

export function setRequestAttribute(key: string, value: AttributeValue): void {
  try {
    writeRequestAttribute(getServerSpan(), getRequestRecord(), key, value);
  } catch (error) {
    logDebug(`Error setting request attribute: ${String(error)}`);
  }
}

// Mirroring attributes into the request record preserves values learned after
// the live span stops recording.
export function writeRequestAttribute(
  span: Span | undefined,
  record: RequestRecord | undefined,
  key: string,
  value: AttributeValue,
): void {
  if (span?.isRecording()) {
    span.setAttribute(key, value);
  }
  if (record) {
    record.attributes[key] = value;
  }
}
