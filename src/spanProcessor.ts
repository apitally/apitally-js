import {
  type Span as ApiSpan,
  type AttributeValue,
  type Context,
  type Exception,
  SpanKind,
} from "@opentelemetry/api";
import { hrTime, hrTimeDuration } from "@opentelemetry/core";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  type ApitallyConfig,
  compilePatterns,
  DEFAULT_EXCLUDE_PATHS,
  EXCLUDE_USER_AGENTS,
  getConfig,
  matchesAny,
  type SamplingCallback,
} from "./config.js";
import { type ApitallyConsumer, consumerFromStringOrObject } from "./consumer.js";
import {
  CONSUMER_HOLDER_KEY,
  type ConsumerHolder,
  getConsumerHolder,
  getRequestRecord,
  getServerSpan,
  REQUEST_RECORD_KEY,
  type RequestDropReason,
  type RequestRecord,
  SPAN_HANDLE_KEY,
  type SpanHandle,
} from "./context.js";
import { logDebug, logWarning } from "./logger.js";

const MAX_BUFFERED_SPANS = 1_000;
const MAX_TRACKED_SPAN_IDS = MAX_BUFFERED_SPANS + 1;
const MAX_STASHED_REQUESTS = 2_048;
const MAX_KEPT_SPAN_IDS = 10_000;

const PER_MESSAGE_SPAN_NAME_SUFFIXES = [
  " http send",
  " http receive",
  " websocket send",
  " websocket receive",
];
const EXCLUDE_USER_AGENT_PATTERNS = compilePatterns(EXCLUDE_USER_AGENTS);

// Transport-captured headers and bodies are attached only to Apitally's export
// copy.
export interface RequestStash {
  requestHeaders?: Record<string, string | string[]>;
  requestBody?: Buffer;
  responseHeaders?: Record<string, string | string[]>;
  responseBody?: Buffer;
}

export interface ApitallySpanData {
  record?: RequestRecord;
  stash?: RequestStash;
  demoteToInternal?: boolean;
}

// Mutable ReadableSpan-shaped copy on Apitally's private export path; the span
// handed to user-attached processors is never mutated.
export type SpanCopy = {
  -readonly [Key in keyof ReadableSpan]: ReadableSpan[Key];
} & { apitallyData?: ApitallySpanData };

// The public processor delegates to the process-global pipeline, so construction
// has no side effects and callbacks before activation are no-ops.
export class ApitallySpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    getActiveSpanPipeline()?.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    getActiveSpanPipeline()?.onEnd(span);
  }

  // Flush failures resolve instead of rejecting into the user's provider.
  forceFlush(): Promise<void> {
    const pipeline = getActiveSpanPipeline();
    if (!pipeline) {
      return Promise.resolve();
    }
    return pipeline.forceFlush().catch((error: unknown) => {
      logDebug(`Error flushing spans: ${String(error)}`);
    });
  }

  // A user provider's shutdown only flushes released requests; SDK shutdown owns
  // teardown.
  shutdown(): Promise<void> {
    return this.forceFlush();
  }
}

// A Symbol.for key lets ESM and CJS builds share the active pipeline.
const ACTIVE_SPAN_PIPELINE_KEY = Symbol.for("apitally.activeSpanPipeline");

export function setActiveSpanPipeline(pipeline: SpanPipeline | undefined): void {
  (globalThis as Record<symbol, SpanPipeline | undefined>)[ACTIVE_SPAN_PIPELINE_KEY] = pipeline;
}

export function getActiveSpanPipeline(): SpanPipeline | undefined {
  return (globalThis as Record<symbol, SpanPipeline | undefined>)[ACTIVE_SPAN_PIPELINE_KEY];
}

export function setConsumer(consumer: ApitallyConsumer | string): void {
  try {
    const holder = getConsumerHolder();
    const normalized = consumerFromStringOrObject(consumer);
    if (!holder || !normalized) {
      return;
    }
    holder.identifier = normalized.identifier;
    holder.name = normalized.name;
    holder.group = normalized.group;
    writeConsumerAttributes(getServerSpan(), getRequestRecord(), normalized);
  } catch (error) {
    logDebug(`Error setting consumer: ${String(error)}`);
  }
}

export function setRequestAttribute(key: string, value: AttributeValue): void {
  try {
    writeRequestAttribute(getServerSpan(), getRequestRecord(), key, value);
  } catch (error) {
    logDebug(`Error setting request attribute: ${String(error)}`);
  }
}

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

// Mirroring attributes into the request record preserves values learned after
// the live span stops recording.
export function writeRequestAttribute(
  span: ApiSpan | undefined,
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

interface RequestEntry {
  readonly serverSpanId: string;
  readonly serverSpan: Span;
  readonly spanIds: Set<string>;
  record?: RequestRecord;
  buffered: ReadableSpan[];
  endedServerSpan?: ReadableSpan;
  transportCompleted: boolean;
  released: boolean;
}

interface KeptSpanEntry {
  readonly serverSpanId: string;
  // Carries the demotion decision across release for spans that end late.
  readonly demoted: boolean;
}

// Requests remain buffered until the SERVER span and transport complete, then
// one keep/drop decision releases them once.
export class SpanPipeline implements SpanProcessor {
  // Callbacks are optional because metrics and log pipelines start at activation.
  metricsRecorder?: (record: RequestRecord) => void;
  onRequestFinished?: (serverSpanId: string, kept: boolean) => void;
  private readonly downstream: SpanProcessor;
  private readonly config: ApitallyConfig;
  private readonly sampleRateBound: bigint;
  private readonly excludePathPatterns: RegExp[];
  // Every span ID remains mapped to one request until completion so late logs
  // resolve. A miss means dropped, completed, or non-request telemetry.
  private readonly requests = new Map<string, RequestEntry>();
  private readonly stash = new Map<string, RequestStash>();
  private readonly demotedSpanIds = new Set<string>();
  // Kept span IDs remain resolvable after release for late spans and logs; the
  // oldest are evicted at the cap.
  private readonly keptSpanIds = new Map<string, KeptSpanEntry>();

  constructor(downstream: SpanProcessor) {
    this.downstream = downstream;
    this.config = getConfig();
    this.sampleRateBound = boundForSampleRate(this.config.sampleRate);
    this.excludePathPatterns = compilePatterns(DEFAULT_EXCLUDE_PATHS, this.config.excludePaths);
  }

  onStart(span: Span, parentContext: Context): void {
    try {
      if (isContribPerMessageSpan(span)) {
        return;
      }
      const parent = span.parentSpanContext;
      if (!parent || parent.isRemote) {
        if (span.kind === SpanKind.SERVER) {
          this.startRequest(span, parentContext);
        }
        return;
      }
      const entry = this.requests.get(parent.spanId);
      const spanId = span.spanContext().spanId;
      if (!entry) {
        // A span started under a request already released as kept exports at
        // its end, like the released request's other late telemetry.
        const kept = this.keptSpanIds.get(parent.spanId);
        if (kept) {
          this.addKeptSpanId(spanId, {
            serverSpanId: kept.serverSpanId,
            demoted: false,
          });
        }
        return;
      }
      if (entry.spanIds.size >= MAX_TRACKED_SPAN_IDS) {
        logDebug("Apitally span tracking cap reached, dropping the span");
        return;
      }
      if (span.kind === SpanKind.SERVER) {
        // A second middleware produced a SERVER span for this request. Apitally
        // demotes its copy, but user exporters retain the duplicate.
        this.demotedSpanIds.add(spanId);
        logWarning(
          `Detected a duplicate SERVER span produced by the instrumentation scope "${span.instrumentationScope?.name ?? "unknown"}" inside an active request. Apitally exports it as an INTERNAL span, but your own OpenTelemetry exporters still receive the duplicate. To resolve this, remove the middleware that produces it.`,
        );
      }
      this.requests.set(spanId, entry);
      entry.spanIds.add(spanId);
    } catch (error) {
      logWarning(`Error in the Apitally span processor: ${String(error)}`);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const spanId = span.spanContext().spanId;
      const isDemoted = this.demotedSpanIds.delete(spanId);
      const entry = this.requests.get(spanId);
      if (!entry) {
        const kept = this.keptSpanIds.get(spanId);
        if (kept) {
          let exportSpan = span;
          if (kept.demoted) {
            const copy = copySpan(span);
            copy.apitallyData = { demoteToInternal: true };
            exportSpan = copy;
          }
          this.downstream.onEnd(exportSpan);
        }
        return;
      }
      if (spanId === entry.serverSpanId) {
        entry.endedServerSpan = span;
        this.releaseIfComplete(entry);
        return;
      }
      // The span id stays mapped so log records emitted after this span ended
      // still resolve to the request until it completes.
      let exportSpan = span;
      if (isDemoted) {
        const copy = copySpan(span);
        copy.apitallyData = { demoteToInternal: true };
        exportSpan = copy;
      }
      if (entry.buffered.length < MAX_BUFFERED_SPANS) {
        entry.buffered.push(exportSpan);
      } else {
        logDebug("Apitally span buffer cap reached, dropping the span");
      }
    } catch (error) {
      logWarning(`Error in the Apitally span processor: ${String(error)}`);
    }
  }

  // Transport completion triggers response sampling and metrics independently
  // of span-end timing. Map misses still record metrics and discard other data.
  handleTransportCompletion(record: RequestRecord): void {
    try {
      const entry =
        record.serverSpanId !== undefined ? this.requests.get(record.serverSpanId) : undefined;
      if (entry && !entry.transportCompleted && !entry.released) {
        // The user-produced SERVER span started before the request record existed;
        // attaching the record here carries transport attributes to the export copy.
        entry.record ??= record;
        entry.transportCompleted = true;
        if (!this.isResponseSampledIn(entry)) {
          this.dropRequestOnResponse(entry, record);
        }
      }
      this.metricsRecorder?.(record);
      if (entry) {
        this.releaseIfComplete(entry);
      }
    } catch (error) {
      logWarning(`Error in the Apitally span processor: ${String(error)}`);
    }
  }

  // Holds captured headers and bodies until the exporter attaches them to the
  // exported SERVER span copy. Fields already stashed are kept unless replaced.
  updateStash(serverSpanId: string, update: RequestStash): void {
    try {
      // A request without an in-flight map entry can never release, so its
      // stash entry would sit unconsumed until the cap evicts it.
      if (!this.requests.has(serverSpanId)) {
        return;
      }
      let entry = this.stash.get(serverSpanId);
      if (!entry) {
        if (this.stash.size >= MAX_STASHED_REQUESTS) {
          const oldestKey = this.stash.keys().next().value;
          if (oldestKey !== undefined) {
            this.stash.delete(oldestKey);
            logDebug("Apitally payload stash cap reached, dropping the oldest entry");
          }
        }
        entry = {};
        this.stash.set(serverSpanId, entry);
      }
      if (update.requestHeaders !== undefined) {
        entry.requestHeaders = update.requestHeaders;
      }
      if (update.requestBody !== undefined) {
        entry.requestBody = update.requestBody;
      }
      if (update.responseHeaders !== undefined) {
        entry.responseHeaders = update.responseHeaders;
      }
      if (update.responseBody !== undefined) {
        entry.responseBody = update.responseBody;
      }
    } catch (error) {
      logDebug(`Error updating the request stash: ${String(error)}`);
    }
  }

  // Kept requests remain resolvable after release so late logs retain their
  // request association.
  resolveServerSpanId(spanId: string): string | undefined {
    return this.requests.get(spanId)?.serverSpanId ?? this.keptSpanIds.get(spanId)?.serverSpanId;
  }

  isRequestInFlight(serverSpanId: string): boolean {
    return this.requests.has(serverSpanId);
  }

  forceFlush(): Promise<void> {
    return this.downstream.forceFlush();
  }

  // Shutdown releases requests with completed transport observation once and
  // discards incomplete requests, which cannot complete afterward.
  async shutdown(): Promise<void> {
    try {
      for (const entry of new Set(this.requests.values())) {
        if (!entry.released && entry.transportCompleted) {
          this.releaseRequest(entry, entry.endedServerSpan ?? entry.serverSpan);
        }
      }
      this.requests.clear();
      this.stash.clear();
      this.demotedSpanIds.clear();
      this.keptSpanIds.clear();
    } catch (error) {
      logWarning(`Error in the Apitally span processor: ${String(error)}`);
    }
    await this.downstream.shutdown();
  }

  private startRequest(span: Span, parentContext: Context): void {
    const spanId = span.spanContext().spanId;
    // The handle is filled for every local-root SERVER span, independent of the
    // keep decision, so runtime writes always reach the current request's span.
    const handle = parentContext.getValue(SPAN_HANDLE_KEY) as SpanHandle | undefined;
    if (handle) {
      handle.span = span;
    }
    const record = parentContext.getValue(REQUEST_RECORD_KEY) as RequestRecord | undefined;
    if (record) {
      record.serverSpanId = spanId;
    }
    const holder = parentContext.getValue(CONSUMER_HOLDER_KEY) as ConsumerHolder | undefined;
    if (holder?.identifier) {
      const consumer = consumerFromStringOrObject({
        identifier: holder.identifier,
        name: holder.name,
        group: holder.group,
      });
      if (consumer) {
        writeConsumerAttributes(span, record, consumer);
      }
    }
    writeUrlAttributesFromFullUrl(span);
    const dropReason = this.resolveDropReasonAtStart(span);
    if (dropReason) {
      if (record) {
        record.dropReason = dropReason;
      }
      return;
    }
    this.requests.set(spanId, {
      serverSpanId: spanId,
      serverSpan: span,
      spanIds: new Set([spanId]),
      record,
      buffered: [],
      transportCompleted: false,
      released: false,
    });
  }

  // Exclusion answers "never wanted" and runs strictly before sampling; an
  // excluded request never invokes a user sampling callback.
  private resolveDropReasonAtStart(span: Span): RequestDropReason | undefined {
    const attributes = span.attributes;
    const method = attributes["http.request.method"] ?? attributes["http.method"];
    if (method === "OPTIONS") {
      return "options";
    }
    const scheme = attributes["url.scheme"] ?? attributes["http.scheme"];
    if (scheme === "ws" || scheme === "wss") {
      return "websocket";
    }
    const path = attributes["url.path"] ?? attributes["http.target"];
    if (typeof path === "string" && matchesAny(this.excludePathPatterns, path.split("?")[0])) {
      return "excluded";
    }
    const userAgent = attributes["user_agent.original"] ?? attributes["http.user_agent"];
    if (typeof userAgent === "string" && matchesAny(EXCLUDE_USER_AGENT_PATTERNS, userAgent)) {
      return "excluded";
    }
    return this.isRequestSampledIn(span) ? undefined : "sampled-out";
  }

  private isRequestSampledIn(span: Span): boolean {
    const callback = this.config.sampleOnRequest;
    const rate = callback
      ? resolveCallbackSampleRate(callback, span, "sampleOnRequest")
      : undefined;
    const bound = rate === undefined ? this.sampleRateBound : boundForSampleRate(rate);
    return isTraceSampledIn(span.spanContext().traceId, bound);
  }

  // Abstention leaves the request-stage decision standing; it never re-tests the
  // static sample rate.
  private isResponseSampledIn(entry: RequestEntry): boolean {
    const callback = this.config.sampleOnResponse;
    if (!callback) {
      return true;
    }
    const serverSpan = entry.endedServerSpan ?? entry.serverSpan;
    let snapshot: ReadableSpan = serverSpan;
    if (entry.record && Object.keys(entry.record.attributes).length > 0) {
      // The callback sees transport-observed values even when they were learned
      // after the span ended (final route, response size).
      const copy = copySpan(serverSpan);
      copy.attributes = {
        ...serverSpan.attributes,
        ...entry.record.attributes,
      };
      snapshot = copy;
    }
    const rate = resolveCallbackSampleRate(callback, snapshot, "sampleOnResponse");
    if (rate === undefined) {
      return true;
    }
    return isTraceSampledIn(serverSpan.spanContext().traceId, boundForSampleRate(rate));
  }

  private dropRequestOnResponse(entry: RequestEntry, record: RequestRecord): void {
    // Removing every span id sends the dropped request's late telemetry to the
    // lookup-miss rule, so it is discarded locally.
    entry.released = true;
    entry.buffered = [];
    record.dropReason = "sampled-out";
    if (entry.record) {
      entry.record.dropReason = "sampled-out";
    }
    this.removeCompletedRequestSpanIds(entry);
    this.stash.delete(entry.serverSpanId);
    this.onRequestFinished?.(entry.serverSpanId, false);
  }

  private releaseIfComplete(entry: RequestEntry): void {
    if (entry.released || !entry.transportCompleted || !entry.endedServerSpan) {
      return;
    }
    this.releaseRequest(entry, entry.endedServerSpan);
  }

  // Descendants, the SERVER span, and logs enter downstream processing once, in
  // that order. The exporter applies the request record and stash later.
  private releaseRequest(entry: RequestEntry, serverSpan: ReadableSpan): void {
    entry.released = true;
    for (const spanId of entry.spanIds) {
      this.requests.delete(spanId);
      this.addKeptSpanId(spanId, {
        serverSpanId: entry.serverSpanId,
        demoted: this.demotedSpanIds.delete(spanId),
      });
    }
    for (const bufferedSpan of entry.buffered) {
      this.downstream.onEnd(bufferedSpan);
    }
    entry.buffered = [];
    const stash = this.stash.get(entry.serverSpanId);
    this.stash.delete(entry.serverSpanId);
    let exportSpan = serverSpan;
    if (entry.record || stash || !serverSpan.ended) {
      const copy = copySpan(serverSpan);
      if (!serverSpan.ended) {
        // A SERVER span released during shutdown uses shutdown as its end time.
        copy.endTime = hrTime();
        copy.duration = hrTimeDuration(copy.startTime, copy.endTime);
        copy.ended = true;
      }
      copy.apitallyData = { record: entry.record, stash };
      exportSpan = copy;
    }
    this.downstream.onEnd(exportSpan);
    this.onRequestFinished?.(entry.serverSpanId, true);
  }

  private removeCompletedRequestSpanIds(entry: RequestEntry): void {
    for (const spanId of entry.spanIds) {
      this.requests.delete(spanId);
      this.demotedSpanIds.delete(spanId);
    }
  }

  private addKeptSpanId(spanId: string, kept: KeptSpanEntry): void {
    if (this.keptSpanIds.size >= MAX_KEPT_SPAN_IDS) {
      const oldestId = this.keptSpanIds.keys().next().value;
      if (oldestId !== undefined) {
        this.keptSpanIds.delete(oldestId);
      }
    }
    this.keptSpanIds.set(spanId, kept);
  }
}

export function copySpan(span: ReadableSpan): SpanCopy {
  const spanContext = span.spanContext();
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => spanContext,
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes: span.attributes,
    links: span.links,
    events: span.events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

function writeConsumerAttributes(
  span: ApiSpan | undefined,
  record: RequestRecord | undefined,
  consumer: ApitallyConsumer,
): void {
  writeRequestAttribute(span, record, "apitally.consumer.identifier", consumer.identifier);
  if (consumer.name) {
    writeRequestAttribute(span, record, "apitally.consumer.name", consumer.name);
  }
  if (consumer.group) {
    writeRequestAttribute(span, record, "apitally.consumer.group", consumer.group);
  }
}

// Missing path, query, and target attributes are derived from the full URL
// because exclusion, display, and redaction require them.
function writeUrlAttributesFromFullUrl(span: Span): void {
  const attributes = span.attributes;
  if (attributes["url.path"] !== undefined || attributes["http.target"] !== undefined) {
    return;
  }
  const url = attributes["url.full"] ?? attributes["http.url"];
  if (typeof url !== "string") {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const query = parsed.search.replace(/^\?/, "");
  span.setAttribute("url.path", parsed.pathname);
  if (query) {
    span.setAttribute("url.query", query);
  }
  span.setAttribute("http.target", query ? `${parsed.pathname}?${query}` : parsed.pathname);
}

const TRACE_ID_LOW_64_BITS_MASK = (1n << 64n) - 1n;

function boundForSampleRate(rate: number): bigint {
  return BigInt(Math.round(rate * 2 ** 64));
}

// Low 64-bit ratio sampling is deterministic per trace. Comparing the same
// value at both stages makes the lower rate decisive.
function isTraceSampledIn(traceId: string, bound: bigint): boolean {
  return (BigInt(`0x${traceId}`) & TRACE_ID_LOW_64_BITS_MASK) < bound;
}

// A throwing or invalid-returning callback resolves to keep: a user bug must
// never lose data without a warning. Undefined means the callback abstained.
function resolveCallbackSampleRate(
  callback: SamplingCallback,
  span: ReadableSpan,
  optionName: string,
): number | undefined {
  let result: unknown;
  try {
    result = callback(span);
  } catch {
    logWarning(`The Apitally ${optionName} callback threw an error, so the request was captured`);
    return 1;
  }
  if (result === undefined || result === null) {
    return undefined;
  }
  if (typeof result === "boolean") {
    return result ? 1 : 0;
  }
  if (typeof result === "number" && result >= 0 && result <= 1) {
    return result;
  }
  logWarning(
    `The Apitally ${optionName} callback returned an invalid value, so the request was captured. Sampling callbacks must synchronously return a number between 0 and 1, a boolean, or undefined.`,
  );
  return 1;
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

// The scope check keeps user-owned socket spans whose names happen to match.
function isContribPerMessageSpan(span: Span): boolean {
  const scopeName = span.instrumentationScope?.name ?? "";
  return (
    span.kind === SpanKind.INTERNAL &&
    PER_MESSAGE_SPAN_NAME_SUFFIXES.some((suffix) => span.name.endsWith(suffix)) &&
    (scopeName.startsWith("@opentelemetry/instrumentation") ||
      scopeName.startsWith("opentelemetry.instrumentation."))
  );
}
