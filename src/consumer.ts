import type { Context, Span } from "@opentelemetry/api";
import {
  CONSUMER_HOLDER_KEY,
  type ConsumerHolder,
  getConsumerHolder,
  getRequestRecord,
  getServerSpan,
  type RequestRecord,
} from "./context.js";
import { logDebug } from "./logger.js";
import { writeRequestAttribute } from "./requestAttributes.js";

export interface ApitallyConsumer {
  identifier: string;
  name?: string;
  group?: string;
}

const CONSUMER_IDENTIFIER_ATTRIBUTE = "apitally.consumer.identifier";
const CONSUMER_NAME_ATTRIBUTE = "apitally.consumer.name";
const CONSUMER_GROUP_ATTRIBUTE = "apitally.consumer.group";

export function setConsumer(consumer: ApitallyConsumer | string): void {
  try {
    const holder = getConsumerHolder();
    const record = getRequestRecord();
    const normalized = normalizeConsumer(consumer);
    if ((!holder && !record) || !normalized) {
      return;
    }
    if (holder) {
      holder.identifier = normalized.identifier;
      holder.name = normalized.name;
      holder.group = normalized.group;
    }
    writeConsumerAttributes(getServerSpan(), record, normalized);
  } catch (error) {
    logDebug(`Error setting consumer: ${String(error)}`);
  }
}

// Applies a consumer inherited in the parent context when a SERVER span starts.
export function writeConsumerAttributesFromContext(
  parentContext: Context,
  span: Span,
  record: RequestRecord | undefined,
): void {
  const holder = parentContext.getValue(CONSUMER_HOLDER_KEY) as ConsumerHolder | undefined;
  if (!holder?.identifier) {
    return;
  }
  const consumer = normalizeConsumer({
    identifier: holder.identifier,
    name: holder.name,
    group: holder.group,
  });
  if (consumer) {
    writeConsumerAttributes(span, record, consumer);
  }
}

function writeConsumerAttributes(
  span: Span | undefined,
  record: RequestRecord | undefined,
  consumer: ApitallyConsumer,
): void {
  writeRequestAttribute(span, record, CONSUMER_IDENTIFIER_ATTRIBUTE, consumer.identifier);
  if (consumer.name) {
    writeRequestAttribute(span, record, CONSUMER_NAME_ATTRIBUTE, consumer.name);
  }
  if (consumer.group) {
    writeRequestAttribute(span, record, CONSUMER_GROUP_ATTRIBUTE, consumer.group);
  }
}

function normalizeConsumer(
  consumer: ApitallyConsumer | string | number | null | undefined,
): ApitallyConsumer | undefined {
  if (typeof consumer === "object" && consumer !== null) {
    const identifier = trimAndCap(consumer.identifier, 128);
    if (!identifier) {
      return undefined;
    }
    return {
      identifier,
      name: trimAndCap(consumer.name, 64),
      group: trimAndCap(consumer.group, 64),
    };
  }
  const identifier = trimAndCap(consumer, 128);
  return identifier ? { identifier } : undefined;
}

function trimAndCap(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  return String(value).trim().slice(0, maxLength) || undefined;
}
