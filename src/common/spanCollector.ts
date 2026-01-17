import {
  context,
  type Context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager as _AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { ApitallyClient } from "./client.js";
import { Logger } from "./logging.js";

/**
 * Extends the official AsyncLocalStorageContextManager to add enterWith support
 * for frameworks that need to persist context across hook boundaries (e.g. Elysia).
 */
class AsyncLocalStorageContextManager extends _AsyncLocalStorageContextManager {
  enterWith(ctx: Context): void {
    // @ts-expect-error: _asyncLocalStorage is private
    this._asyncLocalStorage.enterWith(ctx);
  }
}

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

export default class SpanCollector implements SpanProcessor {
  public enabled: boolean;
  private includedSpanIds: Map<string, Set<string>> = new Map();
  private collectedSpans: Map<string, SpanData[]> = new Map();
  private contextManager?: AsyncLocalStorageContextManager;
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
    this.contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(this.contextManager);

    const provider = new BasicTracerProvider({
      spanProcessors: [this],
    });
    trace.setGlobalTracerProvider(provider);
    this.tracer = trace.getTracer("apitally");
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

    return {
      traceId,
      setName: (name: string) => {
        span.updateName(name);
      },
      runInContext: <T>(fn: () => T): T => {
        return context.with(ctx, fn);
      },
      enterContext: () => {
        this.contextManager?.enterWith(ctx);
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

  async shutdown(): Promise<void> {
    this.enabled = false;
    this.includedSpanIds.clear();
    this.collectedSpans.clear();
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
