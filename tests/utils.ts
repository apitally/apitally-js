import {
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { vi } from "vitest";

export const WRITE_TOKEN = `apt_${"a".repeat(24)}`;

// Captures SDK diagnostics written to process.stderr; the global teardown restores the spy.
export function captureStderr(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(
    (chunk: Uint8Array | string) => {
      written.push(chunk.toString());
      return true;
    },
  );
  return written;
}

// Real OTLP protobuf payloads for export tests, built with the same serializers the SDK uses.
export function buildTracePayload(spanName: string): Uint8Array {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.getTracer("test").startSpan(spanName).end();
  return requireSerialized(
    ProtobufTraceSerializer.serializeRequest(exporter.getFinishedSpans()),
  );
}

export function buildLogsPayload(body: string): Uint8Array {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  provider.getLogger("test").emit({ body });
  return requireSerialized(
    ProtobufLogsSerializer.serializeRequest(exporter.getFinishedLogRecords()),
  );
}

export async function buildMetricsPayload(
  metricName: string,
): Promise<Uint8Array> {
  class CollectOnlyMetricReader extends MetricReader {
    protected async onForceFlush(): Promise<void> {}
    protected async onShutdown(): Promise<void> {}
  }
  const reader = new CollectOnlyMetricReader();
  const provider = new MeterProvider({ readers: [reader] });
  provider.getMeter("test").createCounter(metricName).add(1);
  const { resourceMetrics } = await reader.collect();
  return requireSerialized(
    ProtobufMetricsSerializer.serializeRequest(resourceMetrics),
  );
}

function requireSerialized(payload: Uint8Array | undefined): Uint8Array {
  if (!payload) {
    throw new Error("Failed to serialize OTLP payload");
  }
  return payload;
}
