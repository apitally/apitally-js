import type { AnyValue } from "@opentelemetry/api-logs";

const MAX_LOG_STRING_LENGTH = 2_048;

export function truncateLogStringValue(value: string): string;
export function truncateLogStringValue(value: AnyValue): AnyValue;
export function truncateLogStringValue(value: AnyValue): AnyValue {
  return typeof value === "string" && value.length > MAX_LOG_STRING_LENGTH
    ? value.slice(0, MAX_LOG_STRING_LENGTH)
    : value;
}
