import { defineConfig as defineBodyParserConfig } from "@adonisjs/core/bodyparser";
import BodyParserMiddleware from "@adonisjs/core/bodyparser_middleware";
import { AppFactory } from "@adonisjs/core/factories/app";
import { Router } from "@adonisjs/core/http";
import { ApplicationService } from "@adonisjs/core/types";
import vine from "@vinejs/vine";

import {
  captureError,
  defineConfig as defineApitallyConfig,
  setConsumer,
} from "../../src/adonisjs/index.js";
import ApitallyMiddleware from "../../src/adonisjs/middleware.js";
import { CLIENT_ID, ENV } from "../utils.js";

const BASE_URL = new URL("./tmp/", import.meta.url);

export const createApp = () => {
  const app = new AppFactory().create(BASE_URL) as ApplicationService;

  app.useConfig({
    apitally: defineApitallyConfig({
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
    }),
  });

  return app;
};

export const createRoutes = (router: Router) => {
  const apitallyMiddleware = new ApitallyMiddleware();
  const apitallyHandle = apitallyMiddleware.handle.bind(apitallyMiddleware);

  const bodyParserConfig = defineBodyParserConfig({});
  const bodyParserMiddleware = new BodyParserMiddleware(bodyParserConfig);
  const bodyParserHandle =
    bodyParserMiddleware.handle.bind(bodyParserMiddleware);

  const helloValidator = vine.compile(
    vine.object({
      name: vine.string().trim().minLength(3),
      age: vine.number().min(18),
    }),
  );

  router
    .get("/hello", async ({ request, response, logger }) => {
      const name = request.qs().name;
      const age = request.qs().age;
      response.type("txt");
      logger.info("Pino test");
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
    .post("/hello", async (ctx) => {
      setConsumer(ctx, "test");
      const data = ctx.request.all();
      try {
        const { name, age } = await helloValidator.validate(data);
        ctx.response.type("txt");
        console.warn("Console test");
        return `Hello ${name}! You are ${age} years old!`;
      } catch (error) {
        captureError(error, ctx);
        throw error;
      }
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
