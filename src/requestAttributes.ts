import type { AttributeValue, Span } from "@opentelemetry/api";
import { getRequestRecord, getServerSpan, type RequestRecord } from "./context.js";
import { logDebug } from "./logger.js";

const CUSTOM_ATTRIBUTE_KEYS_ATTRIBUTE = "apitally.request.custom_attribute_keys";

export function setRequestAttribute(key: string, value: AttributeValue): void {
  try {
    const record = getRequestRecord();
    writeRequestAttribute(getServerSpan(), record, key, value);
    if (record) {
      const keys =
        (record.attributes[CUSTOM_ATTRIBUTE_KEYS_ATTRIBUTE] as string[] | undefined) ?? [];
      if (!keys.includes(key)) {
        // A new array leaves already-built export copies unchanged
        record.attributes[CUSTOM_ATTRIBUTE_KEYS_ATTRIBUTE] = [...keys, key];
      }
    }
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
