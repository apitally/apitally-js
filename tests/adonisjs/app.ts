import { defineConfig as defineBodyParserConfig } from "@adonisjs/core/bodyparser";
import BodyParserMiddleware from "@adonisjs/core/bodyparser_middleware";
import { AppFactory } from "@adonisjs/core/factories/app";
import { Router } from "@adonisjs/core/http";
import { ApplicationService } from "@adonisjs/core/types";

import {
  captureError,
  defineConfig as defineApitallyConfig,
} from "../../src/adonisjs/index.js";
import ApitallyMiddleware from "../../src/adonisjs/middleware.js";
import { CLIENT_ID, ENV } from "../utils.js";

const BASE_URL = new URL("./tmp/", import.meta.url);

export const createApp = async () => {
  const app = new AppFactory().create(BASE_URL) as ApplicationService;

  app.useConfig({
    apitally: defineApitallyConfig({
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
  });

  await app.init();
  await app.boot();
  return app;
};

export const createRoutes = (router: Router) => {
  const apitallyMiddleware = new ApitallyMiddleware();
  const apitallyHandle = apitallyMiddleware.handle.bind(apitallyMiddleware);

  const bodyParserConfig = defineBodyParserConfig({});
  const bodyParserMiddleware = new BodyParserMiddleware(bodyParserConfig);
  const bodyParserHandle =
    bodyParserMiddleware.handle.bind(bodyParserMiddleware);

  router
    .get("/hello", async ({ request, response }) => {
      const name = request.qs().name;
      const age = request.qs().age;
      response.type("txt");
      return `Hello ${name}! You are ${age} years old!`;
    })
    .middleware(apitallyHandle);

  router
    .get("/hello/:id", async ({ params }) => {
      const id = params.id;
      return `Hello ID ${id}!`;
    })
    .where("id", /^\d+$/)
    .middleware(apitallyHandle);

  router
    .post("/hello", async ({ request, response }) => {
      const { name, age } = request.body();
      response.type("txt");
      return `Hello ${name}! You are ${age} years old!`;
    })
    .middleware(bodyParserHandle)
    .middleware(apitallyHandle);

  router
    .get("/error", async (ctx) => {
      const error = new Error("test");
      captureError(error, ctx);
      throw error;
    })
    .middleware(apitallyHandle);

  return router;
};
