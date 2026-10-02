import { type Attributes, ValueType } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  DataPointType,
  type ExponentialHistogram,
  type ExponentialHistogramMetricData,
  type GaugeMetricData,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import type { RequestRecord } from "../src/context.js";
import { MetricsPipeline } from "../src/metrics.js";
import {
  captureStderr,
  createInMemorySpool,
  readMetricDataPoints,
  readSerializedResourceMetrics,
} from "./utils.js";

const HISTOGRAM_NAMES = [
  "http.server.request.duration",
  "http.server.request.body.size",
  "http.server.response.body.size",
];

function createMetricsPipeline(): MetricsPipeline {
  return new MetricsPipeline(resourceFromAttributes({}), createInMemorySpool());
}

// Each collection serializes one request with the gauges, then requests with the histograms.
async function collectResourceMetrics(metrics: MetricsPipeline): Promise<ResourceMetrics[]> {
  const previousCount = readSerializedResourceMetrics().length;
  await metrics.collectAndExport();
  return readSerializedResourceMetrics().slice(previousCount);
}

async function collectDurationDataPoints(metrics: MetricsPipeline) {
  return readMetricDataPoints(
    await collectResourceMetrics(metrics),
    "http.server.request.duration",
  );
}

describe("metrics", () => {
  it("records duration and body size histograms with method, route, status code, consumer, scheme, and 5xx-only error type attributes", async () => {
    const metrics = createMetricsPipeline();
    metrics.recordFromRequest({
      attributes: {
        "http.request.method": "GET",
        "http.route": "/items/{id}",
        "http.response.status_code": 200,
        "apitally.consumer.identifier": "tenant-1",
        "url.scheme": "https",
        "http.request.body.size": 10,
        "http.response.body.size": 250,
      },
      durationSeconds: 0.123,
    });
    metrics.recordFromRequest({
      attributes: {
        "http.request.method": "POST",
        "http.route": "/items",
        "http.response.status_code": 500,
        "url.scheme": "https",
        "http.request.body.size": 40,
        "http.response.body.size": 60,
      },
      durationSeconds: 0.5,
    });
    const exported = await collectResourceMetrics(metrics);
    for (const name of HISTOGRAM_NAMES) {
      expect(readMetricDataPoints(exported, name).map((point) => point.attributes)).toEqual([
        {
          "http.request.method": "GET",
          "http.route": "/items/{id}",
          "http.response.status_code": 200,
          "apitally.consumer.identifier": "tenant-1",
          "url.scheme": "https",
        },
        {
          "http.request.method": "POST",
          "http.route": "/items",
          "http.response.status_code": 500,
          "url.scheme": "https",
          "error.type": "500",
        },
      ]);
    }
  });

  it("reads request attributes in the old semantic convention normalization", async () => {
    const metrics = createMetricsPipeline();
    metrics.recordFromRequest({
      attributes: {
        "http.method": "GET",
        "http.route": "/items",
        "http.status_code": 503,
        "http.scheme": "http",
      },
      durationSeconds: 0.02,
    });
    const points = await collectDurationDataPoints(metrics);
    expect(points).toHaveLength(1);
    expect(points[0].attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/items",
      "http.response.status_code": 503,
      "url.scheme": "http",
      "error.type": "503",
    });
  });

  it("skips the body size observations when the request and response sizes are unknown", async () => {
    const metrics = createMetricsPipeline();
    metrics.recordFromRequest({
      attributes: {
        "http.request.method": "GET",
        "http.route": "/items",
        "http.response.status_code": 200,
      },
      durationSeconds: 0.05,
    });
    const exported = await collectResourceMetrics(metrics);
    expect(HISTOGRAM_NAMES.map((name) => readMetricDataPoints(exported, name).length)).toEqual([
      1, 0, 0,
    ]);
  });

  it("counts excluded and sampled-out requests and skips preflight, websocket, and unmatched-route requests", async () => {
    const metrics = createMetricsPipeline();
    const requests: [string | undefined, RequestRecord["dropReason"]][] = [
      ["/excluded", "excluded"],
      ["/sampled-out", "sampled-out"],
      ["/preflight", "method"],
      ["/socket", "scheme"],
      [undefined, undefined],
      ["", undefined],
    ];
    for (const [route, dropReason] of requests) {
      const attributes: Attributes = {
        "http.request.method": "GET",
        "http.response.status_code": 200,
      };
      if (route !== undefined) {
        attributes["http.route"] = route;
      }
      metrics.recordFromRequest({
        attributes,
        durationSeconds: 0.01,
        dropReason,
      });
    }
    const points = await collectDurationDataPoints(metrics);
    expect(points.map((point) => point.attributes["http.route"])).toEqual([
      "/excluded",
      "/sampled-out",
    ]);
  });

  it("exports complete histogram points at scale 3 with bucket indexes matching OpenTelemetry, including exact powers of two", async () => {
    const metrics = createMetricsPipeline();
    const attributes = {
      "http.route": "/items/{id}",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "apitally.consumer.identifier": "tenant-1",
      "url.scheme": "https",
    };
    // The values are not in ascending order, so the bucket array also grows downward.
    for (const [durationSeconds, responseBodySize] of [
      [0.125, 1024],
      [0.1, 1000],
      [0.125, 1025],
    ]) {
      metrics.recordFromRequest({
        attributes: {
          ...attributes,
          "http.request.body.size": 0,
          "http.response.body.size": responseBodySize,
        },
        durationSeconds,
      });
    }
    const [, histogramRequest] = await collectResourceMetrics(metrics);
    const { startTime, endTime } = (
      histogramRequest.scopeMetrics[0].metrics[0] as ExponentialHistogramMetricData
    ).dataPoints[0];
    const histogramMetric = (name: string, unit: string, value: Partial<ExponentialHistogram>) => ({
      descriptor: { name, description: "", unit, valueType: ValueType.DOUBLE },
      aggregationTemporality: AggregationTemporality.DELTA,
      dataPointType: DataPointType.EXPONENTIAL_HISTOGRAM,
      dataPoints: [
        {
          startTime,
          endTime,
          attributes,
          value: {
            scale: 3,
            zeroCount: 0,
            positive: { offset: 0, bucketCounts: [] },
            negative: { offset: 0, bucketCounts: [] },
            ...value,
          },
        },
      ],
    });
    expect(histogramRequest.scopeMetrics).toEqual([
      {
        scope: { name: "apitally" },
        metrics: [
          // 0.1 maps through the logarithm and 0.125 through the exact power-of-two branch
          histogramMetric("http.server.request.duration", "s", {
            count: 3,
            sum: 0.125 + 0.1 + 0.125,
            min: 0.1,
            max: 0.125,
            positive: { offset: -27, bucketCounts: [1, 0, 2] },
          }),
          histogramMetric("http.server.request.body.size", "By", {
            count: 3,
            sum: 0,
            min: 0,
            max: 0,
            zeroCount: 3,
          }),
          // An exact power of two (1024) belongs to the bucket below its boundary, with 1000
          histogramMetric("http.server.response.body.size", "By", {
            count: 3,
            sum: 1024 + 1000 + 1025,
            min: 1000,
            max: 1025,
            positive: { offset: 79, bucketCounts: [2, 1] },
          }),
        ],
      },
    ]);
  });

  it("exports only the combinations recorded since the previous collection", async () => {
    const metrics = createMetricsPipeline();
    const recordRoute = (route: string) =>
      metrics.recordFromRequest({
        attributes: {
          "http.request.method": "GET",
          "http.route": route,
          "http.response.status_code": 200,
        },
        durationSeconds: 0.1,
      });
    recordRoute("/a");
    const [firstPoint] = await collectDurationDataPoints(metrics);
    recordRoute("/b");
    const secondPoints = await collectDurationDataPoints(metrics);
    expect(secondPoints.map((point) => point.attributes["http.route"])).toEqual(["/b"]);
    expect(secondPoints[0].startTime).toEqual(firstPoint.endTime);
  });

  it("drops new combinations beyond 50,000 per collection interval with a single warning", async () => {
    const metrics = createMetricsPipeline();
    // After createMetricsPipeline, whose in-memory spool installs its own stderr capture
    const stderr = captureStderr();
    const recordConsumer = (consumer: string) =>
      metrics.recordFromRequest({
        attributes: {
          "http.request.method": "GET",
          "http.route": "/items",
          "http.response.status_code": 200,
          "apitally.consumer.identifier": consumer,
        },
        durationSeconds: 0.1,
      });
    const consumers = Array.from({ length: 50_002 }, (_, index) => `consumer-${index}`);
    for (const consumer of consumers) {
      recordConsumer(consumer);
    }
    recordConsumer("consumer-0");
    const firstPoints = await collectDurationDataPoints(metrics);
    expect(firstPoints.map((point) => point.attributes["apitally.consumer.identifier"])).toEqual(
      consumers.slice(0, 50_000),
    );
    expect(firstPoints.map((point) => point.value.count)).toEqual([2, ...Array(49_999).fill(1)]);
    recordConsumer("consumer-50000");
    const secondPoints = await collectDurationDataPoints(metrics);
    expect(secondPoints.map((point) => point.attributes["apitally.consumer.identifier"])).toEqual([
      "consumer-50000",
    ]);
    expect(stderr.filter((line) => line.includes("some request metrics are missing"))).toHaveLength(
      1,
    );
  });

  it("splits request histograms into requests of 1,000 combinations that keep each combination's histograms together", async () => {
    const metrics = createMetricsPipeline();
    const consumers = Array.from({ length: 1_001 }, (_, index) => `consumer-${index}`);
    for (const consumer of consumers) {
      metrics.recordFromRequest({
        attributes: {
          "http.request.method": "GET",
          "http.route": "/items",
          "http.response.status_code": 200,
          "apitally.consumer.identifier": consumer,
          "http.request.body.size": 10,
          "http.response.body.size": 100,
        },
        durationSeconds: 0.1,
      });
    }
    const [, ...histogramRequests] = await collectResourceMetrics(metrics);
    const consumersByRequest = histogramRequests.map((resourceMetrics) =>
      resourceMetrics.scopeMetrics[0].metrics.map((metric) =>
        (metric as ExponentialHistogramMetricData).dataPoints.map(
          (point) => point.attributes["apitally.consumer.identifier"],
        ),
      ),
    );
    expect(consumersByRequest).toEqual([
      Array(3).fill(consumers.slice(0, 1_000)),
      Array(3).fill(consumers.slice(1_000)),
    ]);
  });

  it("exports cpu utilization normalized across cpus, rss memory, and uptime gauges as the first request of every collection, with or without traffic", async () => {
    const metrics = createMetricsPipeline();
    const collectionWithoutTraffic = await collectResourceMetrics(metrics);
    metrics.recordFromRequest({
      attributes: {
        "http.request.method": "GET",
        "http.route": "/items",
        "http.response.status_code": 200,
      },
      durationSeconds: 0.01,
    });
    const collectionWithTraffic = await collectResourceMetrics(metrics);
    expect(collectionWithoutTraffic).toHaveLength(1);
    expect(collectionWithTraffic).toHaveLength(2);
    for (const [gaugeRequest] of [collectionWithoutTraffic, collectionWithTraffic]) {
      const gauges = gaugeRequest.scopeMetrics[0].metrics as GaugeMetricData[];
      expect(
        gauges.map(({ descriptor, dataPointType, dataPoints }) => [
          descriptor.name,
          descriptor.unit,
          dataPointType,
          dataPoints.map((point) => point.attributes),
        ]),
      ).toEqual([
        ["process.cpu.utilization", "1", DataPointType.GAUGE, [{}]],
        ["process.memory.usage", "By", DataPointType.GAUGE, [{}]],
        ["process.uptime", "s", DataPointType.GAUGE, [{}]],
      ]);
      const [cpuUtilization, memoryUsage, uptime] = gauges.map(
        (gauge) => gauge.dataPoints[0].value,
      );
      expect(cpuUtilization).toBeGreaterThanOrEqual(0);
      expect(cpuUtilization).toBeLessThanOrEqual(1);
      expect(memoryUsage).toBeGreaterThan(0);
      expect(uptime).toBeGreaterThan(0);
    }
  });
});
