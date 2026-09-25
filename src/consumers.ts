import { createHash } from "node:crypto";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { AnyValueMap } from "@opentelemetry/api-logs";
import { getActivationHandles } from "./activation.js";
import { getRequestRecord, getServerSpan, type RequestRecord } from "./context.js";
import { logDebug } from "./logger.js";
import { writeRequestAttribute } from "./requestAttributes.js";

export interface ApitallyConsumer {
  identifier: string;
  name?: string | null;
  group?: string | null;
  // A partial update: null deletes a key, and undefined leaves it unchanged.
  attributes?: Record<string, string | number | boolean | null | undefined>;
}

export const MAX_CACHED_CONSUMERS = 10_000;

const CONSUMER_IDENTIFIER_ATTRIBUTE = "apitally.consumer.identifier";
const CONSUMER_UPDATE_EVENT_NAME = "apitally.consumer.update";
const MAX_ATTRIBUTES_PER_UPDATE = 10;

// Repeated calls for the same identifier merge; a different identifier starts over.
export function setConsumer(consumer: ApitallyConsumer | string | null | undefined): void {
  try {
    const record = getRequestRecord();
    const normalized = normalizeConsumer(consumer);
    if (!record || !normalized) {
      return;
    }
    const { identifier } = normalized;
    const current =
      record.consumer?.identifier === identifier
        ? record.consumer
        : { identifier, attributes: new Map<string, string | null>() };
    record.consumer = current;
    current.name = normalized.name ?? current.name;
    current.group = normalized.group ?? current.group;
    if (typeof consumer === "object" && consumer?.attributes) {
      for (const [rawKey, rawValue] of Object.entries(consumer.attributes)) {
        if (
          rawValue !== null &&
          typeof rawValue !== "string" &&
          typeof rawValue !== "number" &&
          typeof rawValue !== "boolean"
        ) {
          continue;
        }
        const key = rawKey.trim();
        const value = rawValue === null ? null : String(rawValue).trim() || null;
        if (key.length > 0 && key.length <= 64 && (value?.length ?? 0) <= 1_024) {
          current.attributes.set(key, value);
        }
      }
    }
    writeRequestAttribute(getServerSpan(), record, CONSUMER_IDENTIFIER_ATTRIBUTE, identifier);
  } catch (error) {
    logDebug(`Error setting consumer: ${String(error)}`);
  }
}

// Consumer updates are emitted for every observed request, independent of
// trace sampling and exclusion; an update identical to the last one sent is skipped.
export function emitConsumerUpdateIfChanged(record: RequestRecord): void {
  try {
    const consumer = record.consumer;
    if (!consumer || (!consumer.name && !consumer.group && consumer.attributes.size === 0)) {
      return;
    }
    const handles = getActivationHandles();
    if (!handles) {
      return;
    }
    const attributes = [...consumer.attributes].slice(0, MAX_ATTRIBUTES_PER_UPDATE);
    const sortedAttributes = [...attributes].sort(([a], [b]) => (a < b ? -1 : 1));
    const hash = createHash("sha256")
      .update(JSON.stringify([consumer.name ?? null, consumer.group ?? null, sortedAttributes]))
      .digest("base64");
    // Map iteration follows insertion order, so re-inserting keeps the least
    // recently used identifier first.
    const hashes = handles.consumerUpdateHashes;
    const previousHash = hashes.get(consumer.identifier);
    hashes.delete(consumer.identifier);
    hashes.set(consumer.identifier, hash);
    if (hashes.size > MAX_CACHED_CONSUMERS) {
      hashes.delete(hashes.keys().next().value as string);
    }
    if (hash === previousHash) {
      return;
    }
    const body: AnyValueMap = { identifier: consumer.identifier };
    if (consumer.name) {
      body.name = consumer.name;
    }
    if (consumer.group) {
      body.group = consumer.group;
    }
    if (attributes.length > 0) {
      body.attributes = Object.fromEntries(attributes);
    }
    handles.loggerProvider.getLogger("apitally").emit({
      timestamp: Date.now(),
      context: ROOT_CONTEXT,
      eventName: CONSUMER_UPDATE_EVENT_NAME,
      body,
    });
  } catch (error) {
    logDebug(`Error emitting consumer update: ${String(error)}`);
  }
}

function normalizeConsumer(consumer: ApitallyConsumer | string | number | null | undefined) {
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
  return identifier ? { identifier, name: undefined, group: undefined } : undefined;
}

function trimAndCap(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  return String(value).trim().slice(0, maxLength) || undefined;
}
