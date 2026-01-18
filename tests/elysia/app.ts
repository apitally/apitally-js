import { trace } from "@opentelemetry/api";
import { Elysia, t } from "elysia";

import { apitallyPlugin } from "../../src/elysia/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getApp = () => {
  const app = new Elysia()
    .use(
      apitallyPlugin({
        clientId: CLIENT_ID,
        env: ENV,
        appVersion: "1.2.3",
        requestLogging: {
          enabled: true,
          logRequestHeaders: true,
          logRequestBody: true,
          logResponseBody: true,
          captureLogs: true,
          captureTraces: true,
        },
      }),
    )
    .get(
      "/hello",
      ({ query, apitally }) => {
        const { name, age } = query;
        apitally.consumer = "test";
        console.warn("Console test");
        return `Hello ${name}! You are ${age} years old!`;
      },
      {
        query: t.Object({
          name: t.String({ minLength: 2 }),
          age: t.Number({ minimum: 18 }),
        }),
      },
    )
    .get("/hello/:id", ({ params }) => {
      const { id } = params;
      return { message: `Hello ${id}!` };
    })
    .post(
      "/hello",
      ({ body }) => {
        const { name, age } = body;
        return `Hello ${name}! You are ${age} years old!`;
      },
      {
        body: t.Object({
          name: t.String({ minLength: 2 }),
          age: t.Number({ minimum: 18 }),
        }),
      },
    )
    .get("/error", () => {
      throw new Error("test");
    })
    .get("/traces", async () => {
      const tracer = trace.getTracer("test");
      await tracer.startActiveSpan("outer_span", async (outerSpan) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await tracer.startActiveSpan("inner_span_1", async (innerSpan1) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          innerSpan1.end();
        });
        await tracer.startActiveSpan("inner_span_2", async (innerSpan2) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          innerSpan2.end();
        });
        outerSpan.end();
      });
      return "traces";
    });

  return app;
};
