import type { Attributes } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  type DataPoint,
  DataPointType,
  type ExponentialHistogram,
  type ExponentialHistogramMetricData,
  type GaugeMetricData,
  type MetricData,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import type { RequestRecord } from "../../src/context.js";
import { MetricsPipeline } from "../../src/metrics.js";
import type { Spool } from "../../src/spool.js";
import {
  createInMemorySpool,
  readSerializedResourceMetrics,
} from "../utils.js";

function createMetricsPipeline(
  spool: Spool = createInMemorySpool(),
): MetricsPipeline {
  return new MetricsPipeline(resourceFromAttributes({}), spool);
}

async function collectMetrics(
  metrics: MetricsPipeline,
): Promise<Map<string, MetricData>> {
  const { resourceMetrics } = await metrics.reader.collect();
  return metricsByName(resourceMetrics);
}

function metricsByName(
  resourceMetrics: ResourceMetrics,
): Map<string, MetricData> {
  const byName = new Map<string, MetricData>();
  for (const scopeMetrics of resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) {
      byName.set(metric.descriptor.name, metric);
    }
  }
  return byName;
}

// Instruments without recordings produce no metric entry, so a missing metric
// reads as zero data points.
function histogramPoints(
  collected: Map<string, MetricData>,
  name: string,
): DataPoint<ExponentialHistogram>[] {
  const metric = collected.get(name);
  if (!metric) {
    return [];
  }
  expect(metric.dataPointType).toBe(DataPointType.EXPONENTIAL_HISTOGRAM);
  return (metric as ExponentialHistogramMetricData).dataPoints;
}

function gaugePoints(
  collected: Map<string, MetricData>,
  name: string,
): DataPoint<number>[] {
  const metric = collected.get(name);
  if (!metric) {
    return [];
  }
  expect(metric.dataPointType).toBe(DataPointType.GAUGE);
  return (metric as GaugeMetricData).dataPoints;
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
    const { resourceMetrics } = await metrics.reader.collect();
    expect(resourceMetrics.scopeMetrics).toHaveLength(1);
    expect(resourceMetrics.scopeMetrics[0].scope.name).toBe("apitally");
    const collected = metricsByName(resourceMetrics);
    expect(collected.get("http.server.request.duration")?.descriptor.unit).toBe(
      "s",
    );
    const durationPoints = histogramPoints(
      collected,
      "http.server.request.duration",
    );
    expect(durationPoints).toHaveLength(2);
    expect(durationPoints[0].attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/items/{id}",
      "http.response.status_code": 200,
      "apitally.consumer.identifier": "tenant-1",
      "url.scheme": "https",
    });
    expect(durationPoints[0].value.count).toBe(1);
    expect(durationPoints[0].value.sum).toBeCloseTo(0.123, 8);
    expect(durationPoints[1].attributes).toEqual({
      "http.request.method": "POST",
      "http.route": "/items",
      "http.response.status_code": 500,
      "url.scheme": "https",
      "error.type": "500",
    });
    for (const [name, expectedSums] of [
      ["http.server.request.body.size", [10, 40]],
      ["http.server.response.body.size", [250, 60]],
    ] as const) {
      expect(collected.get(name)?.descriptor.unit).toBe("By");
      const sizePoints = histogramPoints(collected, name);
      expect(sizePoints.map((point) => point.attributes)).toEqual(
        durationPoints.map((point) => point.attributes),
      );
      expect(sizePoints.map((point) => point.value.sum)).toEqual(expectedSums);
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
    const points = histogramPoints(
      await collectMetrics(metrics),
      "http.server.request.duration",
    );
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
    const collected = await collectMetrics(metrics);
    expect(
      histogramPoints(collected, "http.server.request.duration"),
    ).toHaveLength(1);
    expect(
      histogramPoints(collected, "http.server.request.body.size"),
    ).toHaveLength(0);
    expect(
      histogramPoints(collected, "http.server.response.body.size"),
    ).toHaveLength(0);
  });

  it("counts excluded and sampled-out requests and skips preflight, websocket, and unmatched-route requests", async () => {
    const metrics = createMetricsPipeline();
    const requests: [string | undefined, RequestRecord["dropReason"]][] = [
      ["/excluded", "excluded"],
      ["/sampled-out", "sampled-out"],
      ["/preflight", "options"],
      ["/socket", "websocket"],
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
    const points = histogramPoints(
      await collectMetrics(metrics),
      "http.server.request.duration",
    );
    expect(points.map((point) => point.attributes["http.route"])).toEqual([
      "/excluded",
      "/sampled-out",
    ]);
  });

  it("skips preflight and websocket requests identified by their method and scheme attributes alone", async () => {
    const metrics = createMetricsPipeline();
    metrics.recordFromRequest({
      attributes: {
        "http.request.method": "OPTIONS",
        "http.route": "/items",
        "http.response.status_code": 204,
      },
      durationSeconds: 0.01,
    });
    metrics.recordFromRequest({
      attributes: {
        "http.request.method": "GET",
        "http.route": "/socket",
        "url.scheme": "wss",
        "http.response.status_code": 101,
      },
      durationSeconds: 0.01,
    });
    const points = histogramPoints(
      await collectMetrics(metrics),
      "http.server.request.duration",
    );
    expect(points).toHaveLength(0);
  });

  it("applies delta temporality and exponential aggregation to histograms only while gauges keep their last value", async () => {
    const metrics = createMetricsPipeline();
    metrics.recordFromRequest({
      attributes: {
        "http.request.method": "GET",
        "http.route": "/items",
        "http.response.status_code": 200,
      },
      durationSeconds: 0.1,
    });
    const first = await collectMetrics(metrics);
    const duration = first.get("http.server.request.duration");
    expect(duration?.dataPointType).toBe(DataPointType.EXPONENTIAL_HISTOGRAM);
    expect(duration?.aggregationTemporality).toBe(AggregationTemporality.DELTA);
    expect(histogramPoints(first, "http.server.request.duration")).toHaveLength(
      1,
    );
    const uptime = first.get("process.uptime");
    expect(uptime?.dataPointType).toBe(DataPointType.GAUGE);
    expect(uptime?.aggregationTemporality).toBe(
      AggregationTemporality.CUMULATIVE,
    );
    const firstUptimePoints = gaugePoints(first, "process.uptime");
    expect(firstUptimePoints).toHaveLength(1);

    const second = await collectMetrics(metrics);
    expect(
      histogramPoints(second, "http.server.request.duration"),
    ).toHaveLength(0);
    expect(gaugePoints(second, "process.cpu.utilization")).toHaveLength(1);
    expect(gaugePoints(second, "process.memory.usage")).toHaveLength(1);
    const secondUptimePoints = gaugePoints(second, "process.uptime");
    expect(secondUptimePoints).toHaveLength(1);
    expect(secondUptimePoints[0].value).toBeGreaterThanOrEqual(
      firstUptimePoints[0].value,
    );
  });

  it("downscales exported histogram data points to scale 3 with count and sum preserved", async () => {
    const spool = createInMemorySpool();
    const metrics = createMetricsPipeline(spool);
    let expectedSum = 0;
    for (let index = 0; index < 500; index++) {
      // Narrowly clustered values make the aggregator choose a scale above 3.
      const durationSeconds = 0.08 + (0.04 * index) / 500;
      expectedSum += durationSeconds;
      metrics.recordFromRequest({
        attributes: {
          "http.request.method": "GET",
          "http.route": "/items",
          "http.response.status_code": 200,
        },
        durationSeconds,
      });
    }
    await metrics.collectAndExport();
    const resourceMetrics = readSerializedResourceMetrics();
    expect(resourceMetrics).toHaveLength(1);

    const duration = resourceMetrics[0].scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find(
        (metric) => metric.descriptor.name === "http.server.request.duration",
      ) as ExponentialHistogramMetricData;

    expect(duration).toBeDefined();
    const points = duration.dataPoints;
    expect(points).toHaveLength(1);
    expect(points[0].value.scale).toBe(3);
    expect(points[0].value.count).toBe(500);
    expect(points[0].value.sum).toBeCloseTo(expectedSum, 8);
    expect(points[0].value.min).toBe(0.08);
    expect(points[0].value.max).toBe(0.08 + (0.04 * 499) / 500);
    const bucketTotal = (points[0].value.positive?.bucketCounts ?? []).reduce(
      (total, count) => total + count,
      0,
    );
    expect(bucketTotal).toBe(500);
  });

  it("observes cpu utilization normalized across cpus and rss memory on every collection", async () => {
    const metrics = createMetricsPipeline();
    const collected = await collectMetrics(metrics);
    expect(collected.get("process.cpu.utilization")?.descriptor.unit).toBe("1");
    const cpuPoints = gaugePoints(collected, "process.cpu.utilization");
    expect(cpuPoints).toHaveLength(1);
    expect(cpuPoints[0].attributes).toEqual({});
    expect(cpuPoints[0].value).toBeGreaterThanOrEqual(0);
    expect(cpuPoints[0].value).toBeLessThanOrEqual(1);
    expect(collected.get("process.memory.usage")?.descriptor.unit).toBe("By");
    const memoryPoints = gaugePoints(collected, "process.memory.usage");
    expect(memoryPoints).toHaveLength(1);
    expect(memoryPoints[0].attributes).toEqual({});
    expect(memoryPoints[0].value).toBeGreaterThan(0);
    expect(collected.get("process.uptime")?.descriptor.unit).toBe("s");
    const uptimePoints = gaugePoints(collected, "process.uptime");
    expect(uptimePoints).toHaveLength(1);
    expect(uptimePoints[0].value).toBeGreaterThan(0);
  });

  it("exports the process gauges on a collection cycle with zero request traffic", async () => {
    const spool = createInMemorySpool();
    const metrics = createMetricsPipeline(spool);
    await metrics.collectAndExport();
    const resourceMetrics = readSerializedResourceMetrics();
    expect(resourceMetrics).toHaveLength(1);

    const exported = new Map(
      resourceMetrics[0].scopeMetrics
        .flatMap((scope) => scope.metrics)
        .map((metric) => [metric.descriptor.name, metric]),
    );
    expect([...exported.keys()].sort()).toEqual([
      "process.cpu.utilization",
      "process.memory.usage",
      "process.uptime",
    ]);

    const cpuMetric = exported.get(
      "process.cpu.utilization",
    ) as GaugeMetricData;
    const memoryMetric = exported.get(
      "process.memory.usage",
    ) as GaugeMetricData;
    const cpuPoint = cpuMetric.dataPoints[0];
    const memoryPoint = memoryMetric.dataPoints[0];
    expect(cpuPoint.endTime).toBeDefined();
    expect(cpuPoint.endTime).toEqual(memoryPoint.endTime);
  });
});
