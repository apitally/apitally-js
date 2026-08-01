import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { SpanKind } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { isActivated } from "../../src/activation.js";
import { useApitally } from "../../src/nestjs/index.js";
import {
  prepareFirstRequestActivation,
  readActivationDurationDataPoints,
  readActivationSpans,
  readResponseAndSettleTransport,
  readSerializedLogRecords,
  requireActivationHandles,
  WRITE_TOKEN,
} from "../utils.js";
import { AppModule } from "./app.js";

const platforms = [
  { name: "Express", createAdapter: () => new ExpressAdapter() },
  { name: "Fastify", createAdapter: () => new FastifyAdapter() },
];

describe("NestJS adapter", () => {
  it.each(platforms)(
    "observes requests through the $name HTTP adapter",
    async ({ createAdapter }) => {
      prepareFirstRequestActivation();
      const app = await NestFactory.create(AppModule, createAdapter(), { logger: false });
      try {
        useApitally(app, { writeToken: WRITE_TOKEN });
        useApitally(app, { writeToken: WRITE_TOKEN });
        await app.listen(0, "127.0.0.1");
        const baseUrl = await app.getUrl();

        await send(baseUrl, "/items/42", 200);
        expect(isActivated()).toBe(true);
        await send(baseUrl, "/bad-request", 400);
        await send(baseUrl, "/error", 500);

        const spans = await readActivationSpans();
        expect(spans).toHaveLength(3);
        expect(spans.map((span) => [span.name, span.kind])).toEqual([
          ["GET /items/:id", SpanKind.SERVER],
          ["GET /bad-request", SpanKind.SERVER],
          ["GET /error", SpanKind.SERVER],
        ]);
        expect(spans[0].attributes["http.route"]).toBe("/items/:id");
        expect(spans[1].events).toEqual([]);
        expect(spans[2].events).toHaveLength(1);
        expect(spans[2].events[0].name).toBe("exception");
        expect(spans[2].events[0].attributes?.["exception.message"]).toBe("boom");

        const dataPoints = await readActivationDurationDataPoints();
        expect(dataPoints).toHaveLength(3);
        expect(dataPoints[0].attributes["apitally.consumer.identifier"]).toBe("acme");

        const handles = requireActivationHandles();
        await handles.loggerProvider.forceFlush();
        const startupRecords = readSerializedLogRecords().filter(
          (record) => record.eventName === "apitally.app.startup",
        );
        expect(startupRecords).toHaveLength(1);
        const startup = JSON.parse(String(startupRecords[0].body)) as {
          framework: string;
          versions: Record<string, string>;
          paths: { method: string; path: string }[];
        };
        expect(startup.framework).toBe("nestjs");
        expect(startup.versions.nestjs).toMatch(/^(10|11)\./);
        expect(startup.paths).toEqual([
          { method: "GET", path: "/items/:id" },
          { method: "GET", path: "/bad-request" },
          { method: "GET", path: "/error" },
        ]);
      } finally {
        await app.close();
      }
    },
  );
});

async function send(baseUrl: string, path: string, expectedStatus: number): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`);
  await readResponseAndSettleTransport(response);
  expect(response.status).toBe(expectedStatus);
}
