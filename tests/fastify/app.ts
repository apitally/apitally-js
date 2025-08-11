import Fastify from "fastify";

import { apitallyPlugin, setConsumer } from "../../src/fastify/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getApp = async () => {
  const app = Fastify({
    ajv: { customOptions: { allErrors: true } },
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
      console.log("Test 1");
      console.warn("Test 2");
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
      return `Hello ${name}! You are ${age} years old!`;
    },
  );
  app.get("/error", async function () {
    throw new Error("test");
  });

  return app;
};
