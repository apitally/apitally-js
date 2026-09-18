import { availableParallelism } from "node:os";
import type { Attributes, Histogram } from "@opentelemetry/api";
import { ProtobufMetricsSerializer } from "@opentelemetry/otlp-transformer";
import type { Resource } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  type MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import type { RequestRecord } from "./context.js";
import { createMeterProvider } from "./providers.js";
import type { Spool } from "./spool.js";

// Request histograms use finalized transport data, independent of span timing and sampling.
export class MetricsPipeline {
  readonly meterProvider: MeterProvider;
  readonly reader: MetricReader;
  private readonly spool: Spool;
  private readonly requestDuration: Histogram;
  private readonly requestBodySize: Histogram;
  private readonly responseBodySize: Histogram;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuUsageTimeMillis = performance.now();

  constructor(resource: Resource, spool: Spool) {
    this.spool = spool;
    this.reader = new OnDemandMetricReader();
    this.meterProvider = createMeterProvider(resource, [this.reader]);
    const meter = this.meterProvider.getMeter("apitally");
    this.requestDuration = meter.createHistogram("http.server.request.duration", { unit: "s" });
    this.requestBodySize = meter.createHistogram("http.server.request.body.size", { unit: "By" });
    this.responseBodySize = meter.createHistogram("http.server.response.body.size", { unit: "By" });
    meter
      .createObservableGauge("process.cpu.utilization", { unit: "1" })
      .addCallback((result) => result.observe(this.observeCpuUtilization()));
    meter
      .createObservableGauge("process.memory.usage", { unit: "By" })
      .addCallback((result) => result.observe(process.memoryUsage.rss()));
    // Apitally ingest treats every metrics export as a liveness signal, so this
    // gauge keeps each collection non-empty.
    meter
      .createObservableGauge("process.uptime", { unit: "s" })
      .addCallback((result) => result.observe(process.uptime()));
  }

  // Excluded and sampled-out requests count; preflight, websocket, and unmatched routes do not.
  recordFromRequest(record: RequestRecord): void {
    if (record.dropReason === "method" || record.dropReason === "scheme") {
      return;
    }
    const source = record.attributes;
    const method = source["http.request.method"] ?? source["http.method"];
    const scheme = source["url.scheme"] ?? source["http.scheme"];
    const route = source["http.route"];
    if (typeof route !== "string" || route === "") {
      return;
    }
    const attributes: Attributes = { "http.route": route };
    if (method !== undefined) {
      attributes["http.request.method"] = method;
    }
    const statusCode = source["http.response.status_code"] ?? source["http.status_code"];
    if (statusCode !== undefined) {
      attributes["http.response.status_code"] = statusCode;
    }
    const consumer = source["apitally.consumer.identifier"];
    if (consumer !== undefined) {
      attributes["apitally.consumer.identifier"] = consumer;
    }
    if (scheme !== undefined) {
      attributes["url.scheme"] = scheme;
    }
    if (typeof statusCode === "number" && statusCode >= 500) {
      attributes["error.type"] = String(statusCode);
    }
    if (typeof record.durationSeconds === "number") {
      this.requestDuration.record(record.durationSeconds, attributes);
    }
    const requestBodySize = source["http.request.body.size"];
    if (typeof requestBodySize === "number") {
      this.requestBodySize.record(requestBodySize, attributes);
    }
    const responseBodySize = source["http.response.body.size"];
    if (typeof responseBodySize === "number") {
      this.responseBodySize.record(responseBodySize, attributes);
    }
  }

  async collectAndExport(): Promise<void> {
    const { resourceMetrics } = await this.reader.collect();
    const payload = ProtobufMetricsSerializer.serializeRequest(resourceMetrics);
    if (payload) {
      await this.spool.append("metrics", payload);
    }
  }

  private observeCpuUtilization(): number {
    const cpuUsage = process.cpuUsage();
    const nowMillis = performance.now();
    const cpuTimeMicros =
      cpuUsage.user - this.lastCpuUsage.user + (cpuUsage.system - this.lastCpuUsage.system);
    const elapsedMicros = (nowMillis - this.lastCpuUsageTimeMillis) * 1000;
    this.lastCpuUsage = cpuUsage;
    this.lastCpuUsageTimeMillis = nowMillis;
    return elapsedMicros > 0 ? cpuTimeMicros / elapsedMicros / availableParallelism() : 0;
  }
}

// The export worker collects exponential histograms with delta temporality.
// Gauges keep the default aggregation and cumulative temporality.
class OnDemandMetricReader extends MetricReader {
  constructor() {
    super({
      aggregationSelector: (instrumentType) =>
        instrumentType === InstrumentType.HISTOGRAM
          ? { type: AggregationType.EXPONENTIAL_HISTOGRAM }
          : { type: AggregationType.DEFAULT },
      aggregationTemporalitySelector: (instrumentType) =>
        instrumentType === InstrumentType.HISTOGRAM
          ? AggregationTemporality.DELTA
          : AggregationTemporality.CUMULATIVE,
    });
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}
