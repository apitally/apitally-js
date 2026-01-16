import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Logger } from "./logging.js";

export type SpanData = {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startTime: number;
  endTime: number;
  status?: string;
  attributes?: Record<string, unknown>;
};

export default class SpanCollector implements SpanProcessor {
  public enabled: boolean;
  private includedSpanIds: Map<string, Set<string>> = new Map();
  private collectedSpans: Map<string, SpanData[]> = new Map();
  private tracer?: Tracer;
  private logger?: Logger;

  constructor(enabled: boolean, logger?: Logger) {
    this.enabled = enabled;
    this.logger = logger;

    if (enabled) {
      this.setupTracerProvider();
    }
  }

  private setupTracerProvider() {
    const contextManager = new AsyncLocalStorageContextManager();
    if (!context.setGlobalContextManager(contextManager)) {
      this.enabled = false;
      this.logger?.warn(
        "Failed to register ContextManager for Apitally. Trace collection is disabled.",
      );
      return;
    }

    const provider = new BasicTracerProvider({
      spanProcessors: [this],
    });
    if (!trace.setGlobalTracerProvider(provider)) {
      this.enabled = false;
      this.logger?.warn(
        "Failed to register TracerProvider for Apitally. Trace collection is disabled.",
      );
    } else {
      this.tracer = trace.getTracer("apitally");
    }
  }

  async collect<T>(
    next: () => Promise<T>,
    getSpanName?: () => string | undefined | null,
  ): Promise<{ response: T; traceId?: string; spans: SpanData[] }> {
    if (!this.enabled || !this.tracer) {
      const response = await next();
      return { response, spans: [] };
    }

    return await this.tracer.startActiveSpan("root", async (span) => {
      const ctx = span.spanContext();
      const traceId = ctx.traceId;

      this.includedSpanIds.set(traceId, new Set([ctx.spanId]));
      this.collectedSpans.set(traceId, []);

      let response: T;
      try {
        response = await next();
        const spanName = getSpanName?.()?.trim();
        if (spanName) {
          span.updateName(spanName);
        }
      } finally {
        span.end();
      }
      return { response, traceId, spans: this.getAndClearSpans(traceId) };
    });
  }

  private getAndClearSpans(traceId: string): SpanData[] {
    const spans = this.collectedSpans.get(traceId) ?? [];
    this.collectedSpans.delete(traceId);
    this.includedSpanIds.delete(traceId);
    return spans;
  }

  onStart(span: Span): void {
    if (!this.enabled) return;

    const ctx = span.spanContext();
    const traceId = ctx.traceId;
    const spanId = ctx.spanId;

    const includedSpans = this.includedSpanIds.get(traceId);
    if (!includedSpans) return;

    const parentSpanId = span.parentSpanContext?.spanId;
    if (parentSpanId && includedSpans.has(parentSpanId)) {
      includedSpans.add(spanId);
    }
  }

  onEnd(span: ReadableSpan): void {
    if (!this.enabled) return;

    const ctx = span.spanContext();
    const traceId = ctx.traceId;
    const spanId = ctx.spanId;

    const includedSpans = this.includedSpanIds.get(traceId);
    if (!includedSpans || !includedSpans.has(spanId)) return;

    const spans = this.collectedSpans.get(traceId);
    if (spans) {
      spans.push(this.serializeSpan(span));
    }
  }

  private serializeSpan(span: ReadableSpan): SpanData {
    const ctx = span.spanContext();

    const data: SpanData = {
      spanId: ctx.spanId,
      parentSpanId: span.parentSpanContext?.spanId || null,
      name: span.name,
      kind: SpanKind[span.kind] ?? "INTERNAL",
      // HrTime is [seconds, nanoseconds], convert to nanoseconds
      startTime: span.startTime[0] * 1_000_000_000 + span.startTime[1],
      endTime: span.endTime[0] * 1_000_000_000 + span.endTime[1],
    };

    if (span.status.code !== SpanStatusCode.UNSET) {
      data.status = SpanStatusCode[span.status.code];
    }

    if (span.attributes && Object.keys(span.attributes).length > 0) {
      data.attributes = { ...span.attributes };
    }

    return data;
  }

  async shutdown(): Promise<void> {
    this.enabled = false;
    this.includedSpanIds.clear();
    this.collectedSpans.clear();
  }

  async forceFlush(): Promise<void> {
    // Nothing to flush since we collect spans synchronously
  }
}
