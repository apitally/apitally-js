import type { Attributes } from "@opentelemetry/api";
import { SpanKind } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  type Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  BODY_TOO_LARGE,
  type BodyMaskCallback,
  MAX_BODY_SIZE,
} from "./config.js";
import { logDebug, logWarning } from "./logger.js";
import { REDACTED, type Redaction } from "./redaction.js";
import { copySpan, type SpanCopy } from "./spanProcessor.js";
import type { Spool } from "./spool.js";

const QUERY_ATTRIBUTES = new Set([
  "url.query",
  "url.full",
  "http.target",
  "http.url",
]);
const REQUEST_HEADER_ATTRIBUTE_PREFIX = "http.request.header.";
const RESPONSE_HEADER_ATTRIBUTE_PREFIX = "http.response.header.";
const DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";
const SERIALIZATION_CHUNK_SIZE = 32;
const BODY_TOO_LARGE_BUFFER = Buffer.from(BODY_TOO_LARGE);

export interface ApitallySpanExporterOptions {
  redaction: Redaction;
  env: string;
  spool: Spool;
  maskRequestBody?: BodyMaskCallback;
  maskResponseBody?: BodyMaskCallback;
}

// Builds export copies at batch-drain time, off the request path: applies the
// request record, attaches stashed headers and bodies, and redacts, all on
// rewritten copies; the original spans are never mutated.
export class ApitallySpanExporter implements SpanExporter {
  private readonly redaction: Redaction;
  private readonly env: string;
  private readonly spool: Spool;
  private readonly maskRequestBody?: BodyMaskCallback;
  private readonly maskResponseBody?: BodyMaskCallback;

  constructor(options: ApitallySpanExporterOptions) {
    this.redaction = options.redaction;
    this.env = options.env;
    this.spool = options.spool;
    this.maskRequestBody = options.maskRequestBody;
    this.maskResponseBody = options.maskResponseBody;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const appends: Promise<void>[] = [];
    try {
      // Rewritten resources are shared across the batch: the serializer groups
      // resourceSpans by object identity, never by attribute equality.
      const rewrittenResources = new Map<Resource, Resource>();
      const exportCopies: ReadableSpan[] = [];
      for (const span of spans) {
        try {
          exportCopies.push(this.buildExportCopy(span, rewrittenResources));
        } catch {
          // A span that failed redaction must never leave the process
          logWarning(
            "Failed to prepare a span for export to Apitally, so the span was dropped",
          );
        }
      }
      for (
        let start = 0;
        start < exportCopies.length;
        start += SERIALIZATION_CHUNK_SIZE
      ) {
        const payload = ProtobufTraceSerializer.serializeRequest(
          exportCopies.slice(start, start + SERIALIZATION_CHUNK_SIZE),
        );
        if (payload) {
          appends.push(this.spool.append("traces", payload));
        }
      }
    } catch (error) {
      logDebug(`Error exporting spans: ${String(error)}`);
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
        this.redaction.redactHeaders(stash.requestHeaders),
      );
    }
    if (stash?.responseHeaders) {
      writeCapturedHeaderAttributes(
        attributes,
        RESPONSE_HEADER_ATTRIBUTE_PREFIX,
        this.redaction.redactHeaders(stash.responseHeaders),
      );
    }
    const copy = copySpan(span);
    copy.attributes = attributes as Attributes;
    copy.resource = this.resolveExportResource(
      span.resource,
      rewrittenResources,
    );
    if (data?.demoteToInternal) {
      copy.kind = SpanKind.INTERNAL;
    }
    if (
      stash &&
      (stash.requestBody !== undefined || stash.responseBody !== undefined)
    ) {
      // Mask callbacks receive the span as it will be exported, redaction
      // applied and captured headers attached, without the body attributes
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

  // Stock instrumentations set query attributes raw, so query-bearing and captured
  // header attributes are redacted here, in both semconv normalizations, on every
  // span passing through Apitally's export path.
  private redactQueryAndHeaderAttributes(
    attributes: Record<string, unknown>,
  ): void {
    for (const [key, value] of Object.entries(attributes)) {
      if (QUERY_ATTRIBUTES.has(key) && typeof value === "string") {
        attributes[key] = this.redaction.redactQueryParams(
          value,
          key === "url.query",
        );
      } else if (
        key.startsWith(REQUEST_HEADER_ATTRIBUTE_PREFIX) ||
        key.startsWith(RESPONSE_HEADER_ATTRIBUTE_PREFIX)
      ) {
        const headerName = key.slice(
          key.startsWith(REQUEST_HEADER_ATTRIBUTE_PREFIX)
            ? REQUEST_HEADER_ATTRIBUTE_PREFIX.length
            : RESPONSE_HEADER_ATTRIBUTE_PREFIX.length,
        );
        if (this.redaction.shouldRedactHeader(headerName)) {
          attributes[key] = typeof value === "string" ? REDACTED : [REDACTED];
        }
      }
    }
  }

  // Mask callback, then parse, then field redaction, then serialization. Failing
  // closed: a body the user tried to mask is never exported unmasked.
  private processBody(
    snapshot: ReadableSpan,
    body: Buffer,
    maskCallback: BodyMaskCallback | undefined,
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
        // The documented redact-everything signal
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

  // Every export copy's resource has to match the Apitally-Env transport header;
  // a user provider's differing env is rewritten on Apitally's copy only.
  private resolveExportResource(
    resource: Resource,
    rewrittenResources: Map<Resource, Resource>,
  ): Resource {
    const resourceEnv = resource.attributes[DEPLOYMENT_ENVIRONMENT_NAME];
    if (typeof resourceEnv !== "string" || resourceEnv === this.env) {
      return resource;
    }
    const existing = rewrittenResources.get(resource);
    if (existing) {
      return existing;
    }
    logWarning(
      `The tracer provider's resource sets deployment.environment.name to "${resourceEnv}", which differs from the Apitally env "${this.env}". Spans are exported to Apitally with the env "${this.env}".`,
    );
    const rewritten = resourceFromAttributes({
      ...resource.attributes,
      [DEPLOYMENT_ENVIRONMENT_NAME]: this.env,
    });
    rewrittenResources.set(resource, rewritten);
    return rewritten;
  }
}

function writeCapturedHeaderAttributes(
  attributes: Record<string, unknown>,
  prefix: string,
  headers: Record<string, string | string[]>,
): void {
  for (const [name, values] of Object.entries(headers)) {
    attributes[prefix + name] = values;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
