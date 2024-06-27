import Router from "@koa/router";
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import route from "koa-route";

import { useApitally } from "../../src/koa/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getAppWithKoaRouter = () => {
  const app = new Koa();
  const router = new Router();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    appVersion: "1.2.3",
  });

  router.get("/hello", async (ctx) => {
    ctx.state.apitallyConsumer = "test";
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
  });

  app.use(bodyParser());
  app.use(
    route.get("/hello", async (ctx) => {
      ctx.state.apitallyConsumer = "test";
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

  return app;
};
