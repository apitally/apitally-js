import {
  H3,
  defineEventHandler,
  getRouterParam,
  getValidatedQuery,
  readValidatedBody,
} from "h3";
import { z } from "zod";

import { apitallyPlugin } from "../../src/h3/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getApp = async () => {
  const app = new H3({
    debug: true,
    plugins: [
      apitallyPlugin({
        clientId: CLIENT_ID,
        env: ENV,
        appVersion: "1.2.3",
        requestLoggingConfig: {
          enabled: true,
          logQueryParams: true,
          logRequestHeaders: true,
          logRequestBody: true,
          logResponseHeaders: true,
          logResponseBody: true,
        },
      }),
    ],
  });

  const querySchema = z.object({
    name: z.string().min(2),
    age: z.coerce.number().min(18),
  });

  const bodySchema = z.object({
    name: z.string(),
    age: z.number(),
  });

  app.get(
    "/hello",
    defineEventHandler(async (event) => {
      const { name, age } = await getValidatedQuery(event, querySchema.parse);
      event.context.apitallyConsumer = "test";
      return `Hello ${name}! You are ${age} years old!`;
    }),
  );

  app.get(
    "/hello/:id",
    defineEventHandler((event) => {
      const id = getRouterParam(event, "id");
      return `Hello ${id}!`;
    }),
  );

  app.post(
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

  app.get(
    "/error",
    defineEventHandler(() => {
      throw new Error("test");
    }),
  );

  return app;
};
