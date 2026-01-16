import { trace } from "@opentelemetry/api";
import {
  H3,
  defineEventHandler,
  getRouterParam,
  getValidatedQuery,
  readValidatedBody,
} from "h3";
import { z } from "zod";

import { apitallyPlugin, setConsumer } from "../../src/h3/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getApp = async () => {
  const app = new H3({
    debug: true,
    plugins: [
      apitallyPlugin({
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
      }),
    ],
  });
  const nestedApp1 = new H3();
  const nestedApp2 = new H3();

  const querySchema = z.object({
    name: z.string().min(2),
    age: z.coerce.number().min(18),
  });

  const bodySchema = z.object({
    name: z.string(),
    age: z.number(),
  });

  nestedApp1.get(
    "/hello",
    defineEventHandler(async (event) => {
      const { name, age } = await getValidatedQuery(event, querySchema.parse);
      setConsumer(event, "test");
      console.log("Console test");
      return `Hello ${name}! You are ${age} years old!`;
    }),
  );

  nestedApp1.get(
    "/hello/:id",
    defineEventHandler((event) => {
      const id = getRouterParam(event, "id");
      return `Hello ${id}!`;
    }),
  );

  nestedApp1.post(
    "/hello",
    defineEventHandler(async (event) => {
      try {
        const { name, age } = await readValidatedBody(event, bodySchema.parse);
        return `Hello ${name}! You are ${age} years old!`;
      } catch (error) {
        console.error(error);
      }
    }),
  );

  nestedApp2.get(
    "/error",
    defineEventHandler(() => {
      throw new Error("test");
    }),
  );

  nestedApp2.get(
    "/traces",
    defineEventHandler(async () => {
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
    }),
  );

  app.mount("/v1", nestedApp1);
  app.mount("/v2", nestedApp2);

  return app;
};
