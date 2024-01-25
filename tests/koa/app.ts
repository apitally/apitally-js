import Router from "@koa/router";
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import route from "koa-route";

import { requireApiKey, useApitally } from "../../src/koa/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getAppWithKoaRouter = () => {
  const app = new Koa();
  const router = new Router();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    syncApiKeys: true,
    appVersion: "1.2.3",
  });

  router.get("/hello", requireApiKey({ scopes: ["hello1"] }), async (ctx) => {
    ctx.body = `Hello ${ctx.query.name}! You are ${ctx.query.age} years old!`;
  });
  router.get(
    "/hello/:id",
    requireApiKey({ scopes: ["hello2"] }),
    async (ctx) => {
      ctx.body = `Hello ${ctx.params.id}!`;
    },
  );
  router.post("/hello", requireApiKey({ scopes: ["hello1"] }), async (ctx) => {
    const requestBody = ctx.request.body as any;
    ctx.body = `Hello ${requestBody.name}! You are ${requestBody.age} years old!`;
  });
  router.get("/error", requireApiKey(), async () => {
    throw new Error("Error");
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
    syncApiKeys: true,
    appVersion: "1.2.3",
  });

  app.use(requireApiKey({ customHeader: "ApiKey" }));
  app.use(bodyParser());
  app.use(
    route.get("/hello", async (ctx) => {
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
      throw new Error("Error");
    }),
  );

  return app;
};
