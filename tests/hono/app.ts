import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { setConsumer, useApitally } from "../../src/hono/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getApp = async () => {
  const app = new Hono();

  useApitally(app, {
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
    },
  });

  app.get(
    "/hello",
    zValidator(
      "query",
      z.object({
        name: z.string().min(2),
        age: z.coerce.number().min(18),
      }),
    ),
    (c) => {
      setConsumer(c, "test");
      return c.text(
        `Hello ${c.req.query("name")}! You are ${c.req.query("age")} years old!`,
      );
    },
  );

  app.get("/hello/:id", (c) => {
    return c.text(`Hello ${c.req.param("id")}!`);
  });

  app.post("/hello", async (c) => {
    const requestBody = await c.req.json();
    return c.text(
      `Hello ${requestBody.name}! You are ${requestBody.age} years old!`,
    );
  });

  app.get("/error", () => {
    throw new Error("test");
  });

  return app;
};

export const getNestedApp = async () => {
  const app = new Hono().basePath("/api");
  const nestedApp = new Hono();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
  });

  nestedApp.get("/hello", (c) => {
    return c.text("Hello");
  });
  app.route("/v1", nestedApp);

  return app;
};
