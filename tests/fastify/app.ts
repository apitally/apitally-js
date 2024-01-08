import Fastify from "fastify";

import { apitallyPlugin, requireApiKey } from "../../src/fastify/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getApp = async (customHeader?: string) => {
  const app = Fastify({
    ajv: { customOptions: { allErrors: true } },
    // logger: { level: "error" },
  });

  await app.register(apitallyPlugin, {
    clientId: CLIENT_ID,
    env: ENV,
    syncApiKeys: true,
    appVersion: "1.2.3",
  });

  interface HelloQuerystring {
    name: string;
    age: number;
  }

  interface HelloParams {
    id: number;
  }

  app.get<{ Querystring: HelloQuerystring }>(
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
      preValidation: requireApiKey({ scopes: "hello1", customHeader }),
    },
    async function (request) {
      const { name, age } = request.query;
      return `Hello ${name}! You are ${age} years old!`;
    },
  );
  app.get<{ Params: HelloParams }>(
    "/hello/:id",
    { preValidation: requireApiKey({ scopes: "hello2", customHeader }) },
    async function (request) {
      const { id } = request.params;
      return `Hello ${id}!`;
    },
  );
  app.get(
    "/error",
    { preValidation: requireApiKey({ customHeader }) },
    async function () {
      throw new Error("Error");
    },
  );

  return app;
};
