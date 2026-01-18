import { trace } from "@opentelemetry/api";
import Fastify from "fastify";

import { apitallyPlugin, setConsumer } from "../../src/fastify/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getApp = async () => {
  const app = Fastify({
    ajv: { customOptions: { allErrors: true } },
    logger: true,
  });

  await app.register(apitallyPlugin, {
    clientId: CLIENT_ID,
    env: ENV,
    appVersion: "1.2.3",
    requestLogging: {
      enabled: true,
      logQueryParams: true,
      logRequestHeaders: true,
      logRequestBody: true,
      logResponseHeaders: true,
      logResponseBody: true,
      captureLogs: true,
      captureTraces: true,
    },
  });

  interface HelloParams {
    name: string;
    age: number;
  }

  interface HelloIDParams {
    id: number;
  }

  app.get<{ Querystring: HelloParams }>(
    "/hello",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 2 },
            age: { type: "integer", minimum: 18 },
          },
          required: ["name", "age"],
        },
      },
    },
    async function (request) {
      const { name, age } = request.query;
      setConsumer(request, "test");
      console.warn("Console test");
      return `Hello ${name}! You are ${age} years old!`;
    },
  );
  app.get<{ Params: HelloIDParams }>("/hello/:id", async function (request) {
    const { id } = request.params;
    return `Hello ${id}!`;
  });
  app.post<{ Body: HelloParams }>(
    "/hello",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 2 },
            age: { type: "integer", minimum: 18 },
          },
          required: ["name", "age"],
        },
      },
    },
    async function (request) {
      const { name, age } = request.body;
      request.log.info("Test 3");
      return `Hello ${name}! You are ${age} years old!`;
    },
  );
  app.get("/error", async function () {
    throw new Error("test");
  });

  app.get("/traces", async function () {
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("outer_span", async (span) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await tracer.startActiveSpan("inner_span_1", async (innerSpan) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        innerSpan.end();
      });
      await tracer.startActiveSpan("inner_span_2", async (innerSpan) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        innerSpan.end();
      });
      span.end();
    });
    return "traces";
  });

  return app;
};
