import { availableParallelism } from "node:os";
import type { Attributes, Histogram } from "@opentelemetry/api";
import { ProtobufMetricsSerializer } from "@opentelemetry/otlp-transformer";
import type { Resource } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  AggregationType,
  DataPointType,
  type ExponentialHistogram,
  InstrumentType,
  type MeterProvider,
  type MetricData,
  MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { RequestRecord } from "./context.js";
import { createMeterProvider } from "./providers.js";
import type { Spool } from "./spool.js";

// The server accepts exponential histogram scales in [-2, 6], and sdk-metrics
// offers no scale setting, so data points are downscaled before serialization.
const MAX_EXPORTED_HISTOGRAM_SCALE = 3;

// Request histograms and process gauges on the SDK's private meter provider.
// Requests are recorded at transport completion from the finalized request
// record, independent of span-end timing and sampling; collection is driven by
// the export worker, so metrics export in the same cycle as traces and logs.
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
    this.requestDuration = meter.createHistogram(
      "http.server.request.duration",
      { unit: "s" },
    );
    this.requestBodySize = meter.createHistogram(
      "http.server.request.body.size",
      { unit: "By" },
    );
    this.responseBodySize = meter.createHistogram(
      "http.server.response.body.size",
      { unit: "By" },
    );
    meter
      .createObservableGauge("process.cpu.utilization", { unit: "1" })
      .addCallback((result) => result.observe(this.observeCpuUtilization()));
    meter
      .createObservableGauge("process.memory.usage", { unit: "By" })
      .addCallback((result) => result.observe(process.memoryUsage.rss()));
    // Observed unconditionally, so every collection produces a non-empty
    // export; the server reads each metrics export as a liveness signal.
    meter
      .createObservableGauge("process.uptime", { unit: "s" })
      .addCallback((result) => result.observe(process.uptime()));
  }

  // Registered on the span pipeline's metricsRecorder seam, called at transport
  // completion with the finalized record. Excluded and sampled-out requests are
  // counted; preflight, websocket, and unmatched-route requests are not.
  recordFromRequest(record: RequestRecord): void {
    if (record.dropReason === "options" || record.dropReason === "websocket") {
      return;
    }
    const source = record.attributes;
    const route = source["http.route"];
    if (typeof route !== "string" || route === "") {
      return;
    }
    const attributes: Attributes = { "http.route": route };
    const method = source["http.request.method"] ?? source["http.method"];
    if (method !== undefined) {
      attributes["http.request.method"] = method;
    }
    const statusCode =
      source["http.response.status_code"] ?? source["http.status_code"];
    if (statusCode !== undefined) {
      attributes["http.response.status_code"] = statusCode;
    }
    const consumer = source["apitally.consumer.identifier"];
    if (consumer !== undefined) {
      attributes["apitally.consumer.identifier"] = consumer;
    }
    const scheme = source["url.scheme"] ?? source["http.scheme"];
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

  // Called by the export worker each cycle: collects from the reader and
  // appends one OTLP payload to the spool.
  async collectAndExport(): Promise<void> {
    const { resourceMetrics } = await this.reader.collect();
    const payload = ProtobufMetricsSerializer.serializeRequest(
      downscaleExponentialHistograms(resourceMetrics),
    );
    if (payload) {
      await this.spool.append("metrics", payload);
    }
  }

  private observeCpuUtilization(): number {
    const cpuUsage = process.cpuUsage();
    const nowMillis = performance.now();
    const cpuTimeMicros =
      cpuUsage.user -
      this.lastCpuUsage.user +
      (cpuUsage.system - this.lastCpuUsage.system);
    const elapsedMicros = (nowMillis - this.lastCpuUsageTimeMillis) * 1000;
    this.lastCpuUsage = cpuUsage;
    this.lastCpuUsageTimeMillis = nowMillis;
    return elapsedMicros > 0
      ? cpuTimeMicros / elapsedMicros / availableParallelism()
      : 0;
  }
}

// Collects only when asked; the export worker drives collection each cycle.
// The selectors make histograms exponential with delta temporality, the only
// form the server ingests, while gauges keep last-value aggregation and the
// default cumulative temporality.
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

// Downscaling operates on rewritten copies built for serialization only; the
// collected data points are never mutated.
function downscaleExponentialHistograms(
  resourceMetrics: ResourceMetrics,
): ResourceMetrics {
  return {
    resource: resourceMetrics.resource,
    scopeMetrics: resourceMetrics.scopeMetrics.map((scopeMetrics) => ({
      scope: scopeMetrics.scope,
      metrics: scopeMetrics.metrics.map(downscaleMetricData),
    })),
  };
}

function downscaleMetricData(metric: MetricData): MetricData {
  if (metric.dataPointType !== DataPointType.EXPONENTIAL_HISTOGRAM) {
    return metric;
  }
  return {
    ...metric,
    dataPoints: metric.dataPoints.map((dataPoint) =>
      dataPoint.value.scale <= MAX_EXPORTED_HISTOGRAM_SCALE
        ? dataPoint
        : { ...dataPoint, value: downscaleDataPointValue(dataPoint.value) },
    ),
  };
}

// Exponential buckets nest by powers of two, so the index-wise merge is exact:
// the result equals what a native scale-3 aggregator would have recorded.
function downscaleDataPointValue(
  value: ExponentialHistogram,
): ExponentialHistogram {
  const scaleReduction = value.scale - MAX_EXPORTED_HISTOGRAM_SCALE;
  return {
    ...value,
    scale: MAX_EXPORTED_HISTOGRAM_SCALE,
    positive: mergeBuckets(value.positive, scaleReduction),
    negative: mergeBuckets(value.negative, scaleReduction),
  };
}

function mergeBuckets(
  buckets: ExponentialHistogram["positive"],
  scaleReduction: number,
): ExponentialHistogram["positive"] {
  if (buckets.bucketCounts.length === 0) {
    return buckets;
  }
  const factor = 2 ** scaleReduction;
  // Math.floor, not a bit shift, so negative indices merge into the bucket below
  const firstIndex = Math.floor(buckets.offset / factor);
  const lastIndex = Math.floor(
    (buckets.offset + buckets.bucketCounts.length - 1) / factor,
  );
  const bucketCounts = new Array<number>(lastIndex - firstIndex + 1).fill(0);
  for (let i = 0; i < buckets.bucketCounts.length; i++) {
    bucketCounts[Math.floor((buckets.offset + i) / factor) - firstIndex] +=
      buckets.bucketCounts[i];
  }
  return { offset: firstIndex, bucketCounts };
}
