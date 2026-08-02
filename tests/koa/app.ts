import { Readable } from "node:stream";
import { bodyParser } from "@koa/bodyparser";
import Router from "@koa/router";
import Koa from "koa";
import type { ApitallyOptions } from "../../src/config.js";
import { setConsumer } from "../../src/index.js";
import { useApitally } from "../../src/koa/index.js";
import { WRITE_TOKEN } from "../utils.js";

// These fixtures must remain behaviorally aligned across integration suites.
export function buildAppFixture(options: ApitallyOptions = {}): Koa {
  const app = new Koa();
  app.silent = true;
  useApitally(app, { writeToken: WRITE_TOKEN, ...options });

  const router = new Router();
  router.get("/items/:id", (ctx) => {
    ctx.body = { id: Number(ctx.params.id), name: "Widget" };
  });
  router.post("/items", (ctx) => {
    ctx.status = 201;
    ctx.body = { received: ctx.request.body };
  });
  router.get("/healthz", (ctx) => {
    ctx.body = { status: "ok" };
  });
  router.get("/error", () => {
    throw new Error("boom");
  });
  router.get("/consumer", (ctx) => {
    setConsumer({ identifier: "acme", name: "Acme Corp", group: "enterprise" });
    ctx.body = { ok: true };
  });
  router.get("/stream", (ctx) => {
    ctx.type = "text/plain";
    ctx.body = Readable.from(["chunk-1\n", "chunk-2\n", "chunk-3\n"]);
  });

  const apiRouter = new Router({ prefix: "/api" });
  apiRouter.get("/nested/:key", (ctx) => {
    ctx.body = { key: ctx.params.key };
  });
  apiRouter.get("/v2/deep", (ctx) => {
    ctx.body = { deep: true };
  });

  app.use(bodyParser());
  app.use(router.routes());
  app.use(apiRouter.routes());
  app.use(router.allowedMethods());
  app.use(apiRouter.allowedMethods());
  return app;
}
