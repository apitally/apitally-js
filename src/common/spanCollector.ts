import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import {
  type ReadableSpan,
  type Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { ApitallyClient } from "./client.js";

export type SpanData = {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startTime: string; // bigint as string
  endTime: string; // bigint as string
  status?: string;
  attributes?: Record<string, unknown>;
};

export type SpanHandle = {
  traceId?: string;
  setName: (name: string) => void;
  runInContext: <T>(fn: () => T) => T;
  enterContext: () => void;
  end: () => SpanData[] | undefined;
};

const TRACE_MAX_AGE = 5 * 60 * 1000; // 5 minutes

export default class SpanCollector implements SpanProcessor {
  public enabled: boolean;
  private includedSpanIds: Map<string, Set<string>> = new Map();
  private collectedSpans: Map<string, SpanData[]> = new Map();
  private traceStartTimes: Map<string, number> = new Map();
  private maintainIntervalId?: NodeJS.Timeout;
  private tracer?: Tracer;

  constructor(enabled: boolean) {
    this.enabled = enabled;

    if (enabled) {
      this.tracer = trace.getTracer("apitally");
      this.maintainIntervalId = setInterval(() => {
        this.maintain();
      }, 60_000);
    }
  }

  startSpan(): SpanHandle {
    if (!this.enabled || !this.tracer) {
      return {
        setName: () => void 0,
        runInContext: <T>(fn: () => T): T => {
          return fn();
        },
        enterContext: () => void 0,
        end: () => undefined,
      };
    }

    const span = this.tracer.startSpan("root");
    const spanCtx = span.spanContext();
    const traceId = spanCtx.traceId;
    const ctx = trace.setSpan(context.active(), span);
    let ended = false;

    this.includedSpanIds.set(traceId, new Set([spanCtx.spanId]));
    this.collectedSpans.set(traceId, []);
    this.traceStartTimes.set(traceId, Date.now());

    return {
      traceId,
      setName: (name: string) => {
        span.updateName(name);
      },
      runInContext: <T>(fn: () => T): T => {
        return context.with(ctx, fn);
      },
      enterContext: () => {
        try {
          // Access the global context manager's internal AsyncLocalStorage
          const contextManager = (context as any)._getContextManager?.();
          contextManager?._asyncLocalStorage?.enterWith(ctx);
        } catch {
          // Ignore errors accessing internals
        }
      },
      end: () => {
        if (ended) return;
        span.end();
        ended = true;
        return this.getAndClearSpans(traceId);
      },
    };
  }

  private getAndClearSpans(traceId: string): SpanData[] {
    const spans = this.collectedSpans.get(traceId) ?? [];
    this.collectedSpans.delete(traceId);
    this.includedSpanIds.delete(traceId);
    this.traceStartTimes.delete(traceId);
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
      // HrTime is [seconds, nanoseconds], convert to nanoseconds as string to avoid precision loss
      startTime: (
        BigInt(span.startTime[0]) * 1_000_000_000n +
        BigInt(span.startTime[1])
      ).toString(),
      endTime: (
        BigInt(span.endTime[0]) * 1_000_000_000n +
        BigInt(span.endTime[1])
      ).toString(),
    };

    if (span.status.code !== SpanStatusCode.UNSET) {
      data.status = SpanStatusCode[span.status.code];
    }

    if (span.attributes && Object.keys(span.attributes).length > 0) {
      data.attributes = { ...span.attributes };
    }

    return data;
  }

  private maintain() {
    const now = Date.now();
    for (const [traceId, startTime] of this.traceStartTimes) {
      if (now - startTime > TRACE_MAX_AGE) {
        this.collectedSpans.delete(traceId);
        this.includedSpanIds.delete(traceId);
        this.traceStartTimes.delete(traceId);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.enabled = false;
    this.includedSpanIds.clear();
    this.collectedSpans.clear();
    this.traceStartTimes.clear();
    if (this.maintainIntervalId) {
      clearInterval(this.maintainIntervalId);
    }
  }

  async forceFlush(): Promise<void> {
    // Nothing to flush since we collect spans synchronously
  }
}

export class ApitallySpanProcessor implements SpanProcessor {
  private getCollector(): SpanCollector | undefined {
    try {
      return ApitallyClient.getInstance().spanCollector;
    } catch {
      return undefined;
    }
  }

  onStart(span: Span) {
    this.getCollector()?.onStart(span);
  }

  onEnd(span: ReadableSpan) {
    this.getCollector()?.onEnd(span);
  }

  async shutdown() {
    this.getCollector()?.shutdown();
  }

  async forceFlush() {
    this.getCollector()?.forceFlush();
  }
}
