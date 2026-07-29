import type { Attributes } from "@opentelemetry/api";
import { SpanKind } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  BODY_TOO_LARGE,
  BODY_TOO_LARGE_BUFFER,
  type BodyMaskingCallback,
  DEFAULT_ENV,
  MAX_BODY_SIZE,
} from "./config.js";
import { logDebug, logWarning } from "./logger.js";
import { REDACTED, type Redaction } from "./redaction.js";
import { copySpan, type SpanCopy } from "./spanProcessor.js";
import type { Signal, Spool } from "./spool.js";

const QUERY_ATTRIBUTES = new Set(["url.query", "url.full", "http.target", "http.url"]);
const REQUEST_HEADER_ATTRIBUTE_PREFIX = "http.request.header.";
const RESPONSE_HEADER_ATTRIBUTE_PREFIX = "http.response.header.";
const DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";
const SERIALIZATION_CHUNK_SIZE = 32;

export interface ApitallySpanExporterOptions {
  redaction: Redaction;
  env: string;
  spool: Spool;
  maskRequestBody?: BodyMaskingCallback;
  maskResponseBody?: BodyMaskingCallback;
}

// Export copies receive transport attributes, captured data, and redaction
// without mutating the original spans.
export class ApitallySpanExporter implements SpanExporter {
  private readonly redaction: Redaction;
  private readonly env: string;
  private readonly spool: Spool;
  private readonly maskRequestBody?: BodyMaskingCallback;
  private readonly maskResponseBody?: BodyMaskingCallback;

  constructor(options: ApitallySpanExporterOptions) {
    this.redaction = options.redaction;
    this.env = options.env;
    this.spool = options.spool;
    this.maskRequestBody = options.maskRequestBody;
    this.maskResponseBody = options.maskResponseBody;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // Rewritten resources are shared across the batch: the serializer groups
    // resourceSpans by object identity, never by attribute equality.
    const rewrittenResources = new Map<Resource, Resource>();
    const exportCopies: ReadableSpan[] = [];
    for (const span of spans) {
      try {
        exportCopies.push(this.buildExportCopy(span, rewrittenResources));
      } catch {
        // A span that failed redaction must never leave the process.
        logWarning("Failed to prepare a span for export to Apitally, so the span was dropped");
      }
    }
    serializeInChunksToSpool(
      exportCopies,
      (chunk) => ProtobufTraceSerializer.serializeRequest(chunk),
      this.spool,
      "traces",
      resultCallback,
    );
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  private buildExportCopy(
    span: ReadableSpan,
    rewrittenResources: Map<Resource, Resource>,
  ): ReadableSpan {
    const data = (span as SpanCopy).apitallyData;
    const stash = data?.stash;
    // The record is applied last: a transport-observed value wins over anything
    // the producing instrumentation set for the same key.
    const attributes: Record<string, unknown> = {
      ...span.attributes,
      ...data?.record?.attributes,
    };
    this.redactQueryAndHeaderAttributes(attributes);
    if (stash?.requestHeaders) {
      writeCapturedHeaderAttributes(
        attributes,
        REQUEST_HEADER_ATTRIBUTE_PREFIX,
        stash.requestHeaders,
        this.redaction,
      );
    }
    if (stash?.responseHeaders) {
      writeCapturedHeaderAttributes(
        attributes,
        RESPONSE_HEADER_ATTRIBUTE_PREFIX,
        stash.responseHeaders,
        this.redaction,
      );
    }
    const copy = copySpan(span);
    copy.attributes = attributes as Attributes;
    copy.resource = this.resolveExportResource(span.resource, rewrittenResources);
    if (data?.demoteToInternal) {
      copy.kind = SpanKind.INTERNAL;
    }
    if (stash && (stash.requestBody !== undefined || stash.responseBody !== undefined)) {
      // Mask callbacks receive the redacted export copy with captured headers
      // attached, but without body attributes.
      const snapshot = copySpan(copy);
      snapshot.attributes = { ...attributes } as Attributes;
      if (stash.requestBody !== undefined) {
        attributes["apitally.request.body"] = this.processBody(
          snapshot,
          stash.requestBody,
          this.maskRequestBody,
          "maskRequestBody",
        );
      }
      if (stash.responseBody !== undefined) {
        attributes["apitally.response.body"] = this.processBody(
          snapshot,
          stash.responseBody,
          this.maskResponseBody,
          "maskResponseBody",
        );
      }
    }
    return copy;
  }

  // OpenTelemetry HTTP instrumentations leave query and header attributes raw.
  // Both legacy and stable HTTP attribute names are redacted before export.
  private redactQueryAndHeaderAttributes(attributes: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(attributes)) {
      if (QUERY_ATTRIBUTES.has(key) && typeof value === "string") {
        attributes[key] = this.redaction.redactQueryParams(value, key === "url.query");
      } else if (
        key.startsWith(REQUEST_HEADER_ATTRIBUTE_PREFIX) ||
        key.startsWith(RESPONSE_HEADER_ATTRIBUTE_PREFIX)
      ) {
        const headerName = key.slice(
          key.startsWith(REQUEST_HEADER_ATTRIBUTE_PREFIX)
            ? REQUEST_HEADER_ATTRIBUTE_PREFIX.length
            : RESPONSE_HEADER_ATTRIBUTE_PREFIX.length,
        );
        attributes[key] = this.redaction.redactHeaderValue(headerName, value);
      }
    }
  }

  // Bodies are masked, parsed, field-redacted, and serialized in that order.
  // Masking failures redact the entire body.
  private processBody(
    snapshot: ReadableSpan,
    body: Buffer,
    maskCallback: BodyMaskingCallback | undefined,
    optionName: string,
  ): string | Buffer {
    if (body.equals(BODY_TOO_LARGE_BUFFER)) {
      return BODY_TOO_LARGE;
    }
    let processed = body;
    if (maskCallback) {
      let masked: unknown;
      try {
        masked = maskCallback(body, snapshot);
      } catch {
        logWarning(
          `The Apitally ${optionName} callback threw an error, so the body was replaced with ${REDACTED}`,
        );
        return REDACTED;
      }
      if (masked === null || masked === undefined) {
        return REDACTED;
      }
      if (!Buffer.isBuffer(masked)) {
        logWarning(
          `The Apitally ${optionName} callback returned an invalid value, so the body was replaced with ${REDACTED}. Mask callbacks must synchronously return a Buffer or null.`,
        );
        return REDACTED;
      }
      if (masked.length > MAX_BODY_SIZE) {
        return BODY_TOO_LARGE;
      }
      processed = masked;
    }
    return this.redaction.redactBody(processed);
  }

  // Export resources must match Apitally-Env. Conflicting values are rewritten
  // only on Apitally's copy, and missing non-default values are added.
  private resolveExportResource(
    resource: Resource,
    rewrittenResources: Map<Resource, Resource>,
  ): Resource {
    const resourceEnv = resource.attributes[DEPLOYMENT_ENVIRONMENT_NAME];
    const conflicts = typeof resourceEnv === "string" && resourceEnv !== this.env;
    const missing = resourceEnv === undefined && this.env !== DEFAULT_ENV;
    if (!conflicts && !missing) {
      return resource;
    }
    const existing = rewrittenResources.get(resource);
    if (existing) {
      return existing;
    }
    if (conflicts) {
      logWarning(
        `The tracer provider's resource sets deployment.environment.name to "${resourceEnv}", which differs from the Apitally env "${this.env}". Spans are exported to Apitally with the env "${this.env}".`,
      );
    }
    const rewritten = resourceFromAttributes({
      ...resource.attributes,
      [DEPLOYMENT_ENVIRONMENT_NAME]: this.env,
    });
    rewrittenResources.set(resource, rewritten);
    return rewritten;
  }
}

export function serializeInChunksToSpool<Item>(
  items: Item[],
  serializeChunk: (chunk: Item[]) => Uint8Array | undefined,
  spool: Spool,
  signal: Signal,
  resultCallback: (result: ExportResult) => void,
): void {
  const appends: Promise<void>[] = [];
  try {
    for (let start = 0; start < items.length; start += SERIALIZATION_CHUNK_SIZE) {
      const payload = serializeChunk(items.slice(start, start + SERIALIZATION_CHUNK_SIZE));
      if (payload) {
        appends.push(spool.append(signal, payload));
      }
    }
  } catch (error) {
    logDebug(`Error exporting ${signal}: ${String(error)}`);
    resultCallback({ code: ExportResultCode.FAILED, error: toError(error) });
    return;
  }
  Promise.all(appends).then(
    () => resultCallback({ code: ExportResultCode.SUCCESS }),
    (error: unknown) =>
      resultCallback({
        code: ExportResultCode.FAILED,
        error: toError(error),
      }),
  );
}

function writeCapturedHeaderAttributes(
  attributes: Record<string, unknown>,
  prefix: string,
  headers: Record<string, string | string[]>,
  redaction: Redaction,
): void {
  for (const [name, values] of Object.entries(headers)) {
    const redactedValues = redaction.redactHeaderValue(name, values);
    attributes[prefix + name] = Array.isArray(redactedValues) ? redactedValues : [redactedValues];
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
