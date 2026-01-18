import Router from "@koa/router";
import { trace } from "@opentelemetry/api";
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import route from "koa-route";

import { setConsumer, useApitally } from "../../src/koa/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

const requestLoggingConfig = {
  enabled: true,
  logQueryParams: true,
  logRequestHeaders: true,
  logRequestBody: true,
  logResponseHeaders: true,
  logResponseBody: true,
  captureLogs: true,
  captureTraces: true,
};

export const getAppWithKoaRouter = () => {
  const app = new Koa();
  const router = new Router();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    appVersion: "1.2.3",
    requestLogging: requestLoggingConfig,
  });

  router.get("/hello", async (ctx) => {
    setConsumer(ctx, "test");
    console.warn("Console test");
    ctx.body = `Hello ${ctx.query.name}! You are ${ctx.query.age} years old!`;
  });
  router.get("/hello/:id", async (ctx) => {
    ctx.body = `Hello ${ctx.params.id}!`;
  });
  router.post("/hello", async (ctx) => {
    const requestBody = ctx.request.body as any;
    ctx.body = `Hello ${requestBody.name}! You are ${requestBody.age} years old!`;
  });
  router.get("/error", async () => {
    throw new Error("test");
  });
  router.get("/traces", async (ctx) => {
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
    ctx.body = "traces";
  });

  app.use(bodyParser());
  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
};

export const getAppWithKoaRoute = () => {
  const app = new Koa();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    appVersion: "1.2.3",
    requestLogging: requestLoggingConfig,
  });

  app.use(bodyParser());
  app.use(
    route.get("/hello", async (ctx) => {
      setConsumer(ctx, "test");
      console.warn("Console test");
      ctx.body = `Hello ${ctx.query.name}! You are ${ctx.query.age} years old!`;
    }),
  );
  app.use(
    route.get("/hello/:id", async (ctx, id) => {
      ctx.body = `Hello ${id}!`;
    }),
  );
  app.use(
    route.post("/hello", async (ctx) => {
      const requestBody = ctx.request.body as any;
      ctx.body = `Hello ${requestBody.name}! You are ${requestBody.age} years old!`;
    }),
  );
  app.use(
    route.get("/error", async () => {
      throw new Error("test");
    }),
  );
  app.use(
    route.get("/traces", async (ctx) => {
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
      ctx.body = "traces";
    }),
  );

  return app;
};
