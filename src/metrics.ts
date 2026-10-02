import { availableParallelism } from "node:os";
import { type Attributes, ValueType } from "@opentelemetry/api";
import { millisToHrTime } from "@opentelemetry/core";
import { ProtobufMetricsSerializer } from "@opentelemetry/otlp-transformer";
import type { Resource } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  DataPointType,
  type ExponentialHistogramMetricData,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import type { RequestRecord } from "./context.js";
import { logWarning } from "./logger.js";
import type { Spool } from "./spool.js";

const HISTOGRAM_SCALE = 3;
const SCALE_FACTOR = Math.LOG2E * 2 ** HISTOGRAM_SCALE;
// Guards against misuse such as a request ID used as the consumer identifier.
const MAX_COMBINATIONS = 50_000;
// Keeps each appended request well below the spool's 4 MB file rotation threshold.
const COMBINATIONS_PER_REQUEST = 1_000;
const CAPACITY_WARNING = `Apitally request metrics exceeded the capacity of ${MAX_COMBINATIONS.toLocaleString("en-US")} distinct attribute combinations per collection interval, so some request metrics are missing.`;
const HISTOGRAM_METRICS = [
  ["http.server.request.duration", "s", "duration"],
  ["http.server.request.body.size", "By", "requestBodySize"],
  ["http.server.response.body.size", "By", "responseBodySize"],
] as const;

interface RequestHistograms {
  attributes: Attributes;
  duration: ExponentialHistogram;
  requestBodySize: ExponentialHistogram;
  responseBodySize: ExponentialHistogram;
}

// Request histograms use finalized transport data, independent of span timing and sampling.
export class MetricsPipeline {
  private readonly resource: Resource;
  private readonly spool: Spool;
  private combinations = new Map<string, RequestHistograms>();
  private intervalStartTime = millisToHrTime(Date.now());
  private lastCpuUsage = process.cpuUsage();
  private lastCpuUsageTimeMillis = performance.now();

  constructor(resource: Resource, spool: Spool) {
    this.resource = resource;
    this.spool = spool;
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
    // Attributes are always set in the same order, so equal combinations give equal keys.
    const key = JSON.stringify(attributes);
    let histograms = this.combinations.get(key);
    if (histograms === undefined) {
      if (this.combinations.size >= MAX_COMBINATIONS) {
        logWarning(CAPACITY_WARNING);
        return;
      }
      histograms = {
        attributes,
        duration: new ExponentialHistogram(),
        requestBodySize: new ExponentialHistogram(),
        responseBodySize: new ExponentialHistogram(),
      };
      this.combinations.set(key, histograms);
    }
    if (typeof record.durationSeconds === "number") {
      histograms.duration.record(record.durationSeconds);
    }
    const requestBodySize = source["http.request.body.size"];
    if (typeof requestBodySize === "number") {
      histograms.requestBodySize.record(requestBodySize);
    }
    const responseBodySize = source["http.response.body.size"];
    if (typeof responseBodySize === "number") {
      histograms.responseBodySize.record(responseBodySize);
    }
  }

  async collectAndExport(): Promise<void> {
    const combinations = [...this.combinations.values()];
    this.combinations = new Map();
    const startTime = this.intervalStartTime;
    const endTime = millisToHrTime(Date.now());
    this.intervalStartTime = endTime;
    const gauges: [string, string, number][] = [
      ["process.cpu.utilization", "1", this.observeCpuUtilization()],
      ["process.memory.usage", "By", process.memoryUsage.rss()],
      ["process.uptime", "s", process.uptime()],
    ];
    // Apitally ingest treats every metrics export as a liveness signal, so the
    // gauges are appended on every collection.
    await this.append(
      gauges.map(([name, unit, value]) => ({
        descriptor: { name, description: "", unit, valueType: ValueType.DOUBLE },
        aggregationTemporality: AggregationTemporality.CUMULATIVE,
        dataPointType: DataPointType.GAUGE,
        dataPoints: [{ startTime, endTime, attributes: {}, value }],
      })),
    );
    // Each combination's histograms stay in one request because Apitally ingest
    // joins them per resource entry.
    for (let index = 0; index < combinations.length; index += COMBINATIONS_PER_REQUEST) {
      const slice = combinations.slice(index, index + COMBINATIONS_PER_REQUEST);
      const metrics: ExponentialHistogramMetricData[] = [];
      for (const [name, unit, field] of HISTOGRAM_METRICS) {
        const dataPoints = slice
          .filter((histograms) => histograms[field].count > 0)
          .map(({ attributes, [field]: histogram }) => ({
            startTime,
            endTime,
            attributes,
            value: {
              count: histogram.count,
              sum: histogram.sum,
              min: histogram.min,
              max: histogram.max,
              scale: HISTOGRAM_SCALE,
              zeroCount: histogram.zeroCount,
              positive: { offset: histogram.offset, bucketCounts: histogram.bucketCounts },
              negative: { offset: 0, bucketCounts: [] },
            },
          }));
        if (dataPoints.length > 0) {
          metrics.push({
            descriptor: { name, description: "", unit, valueType: ValueType.DOUBLE },
            aggregationTemporality: AggregationTemporality.DELTA,
            dataPointType: DataPointType.EXPONENTIAL_HISTOGRAM,
            dataPoints,
          });
        }
      }
      await this.append(metrics);
    }
  }

  private async append(metrics: MetricData[]): Promise<void> {
    const payload = ProtobufMetricsSerializer.serializeRequest({
      resource: this.resource,
      scopeMetrics: [{ scope: { name: "apitally" }, metrics }],
    });
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

// Base-2 exponential histogram at a fixed scale for non-negative values, with the
// bucket indexes of the OpenTelemetry specification.
class ExponentialHistogram {
  count = 0;
  sum = 0;
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;
  zeroCount = 0;
  offset = 0;
  bucketCounts: number[] = [];

  record(value: number): void {
    this.count++;
    this.sum += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    if (value === 0) {
      this.zeroCount++;
      return;
    }
    const index = mapToIndex(value);
    if (this.bucketCounts.length === 0) {
      this.offset = index;
    } else if (index < this.offset) {
      this.bucketCounts.unshift(...new Array<number>(this.offset - index).fill(0));
      this.offset = index;
    }
    const position = index - this.offset;
    while (this.bucketCounts.length <= position) {
      this.bucketCounts.push(0);
    }
    this.bucketCounts[position]++;
  }
}

function mapToIndex(value: number): number {
  const exponent = Math.floor(Math.log2(value));
  // Exact powers of two are the inclusive upper boundary of the bucket below.
  if (2 ** exponent === value) {
    return (exponent << HISTOGRAM_SCALE) - 1;
  }
  return Math.floor(Math.log(value) * SCALE_FACTOR);
}
