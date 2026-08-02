import Router from "@koa/router";
import Koa from "koa";
import route from "koa-route";
import { describe, expect, it } from "vitest";
import { resolveMatchedRoute, resolveStartupPaths } from "../../src/koa/routes.js";
import { withServer } from "../utils.js";

function observeMatchedRoutes(app: Koa): (string | undefined)[] {
  const routes: (string | undefined)[] = [];
  app.use(async (ctx, next) => {
    await next();
    routes.push(resolveMatchedRoute(ctx));
  });
  return routes;
}

async function sendRequests(app: Koa, paths: string[]): Promise<void> {
  await withServer(app.callback(), async (_server, baseUrl) => {
    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`);
      await response.arrayBuffer();
    }
  });
}

describe("koa routes", () => {
  it("enumerates registered string and regex route templates at startup", () => {
    const app = new Koa();
    const router = new Router({ prefix: "/api" });
    router.get("/items/:id", () => {});
    router.post("/items", () => {});
    app.use(router.routes());
    const regexRouter = new Router();
    regexRouter.get(/^\/regex\/\d+$/, () => {});
    app.use(regexRouter.routes());

    expect(resolveStartupPaths(app)).toEqual([
      { method: "HEAD", path: "/api/items/:id" },
      { method: "GET", path: "/api/items/:id" },
      { method: "POST", path: "/api/items" },
      { method: "HEAD", path: "/^\\/regex\\/\\d+$/" },
      { method: "GET", path: "/^\\/regex\\/\\d+$/" },
    ]);
  });

  it("resolves prefixed and regex @koa/router templates and reports no unmatched route", async () => {
    const app = new Koa();
    const routes = observeMatchedRoutes(app);
    const router = new Router({ prefix: "/api" });
    router.get("/items/:id", (ctx) => {
      ctx.body = "ok";
    });
    app.use(router.routes());
    const regexRouter = new Router();
    regexRouter.get(/^\/regex\/\d+$/, (ctx) => {
      ctx.body = "ok";
    });
    app.use(regexRouter.routes());

    await sendRequests(app, ["/api/items/42", "/regex/7", "/unknown"]);

    expect(routes).toEqual(["/api/items/:id", "/^\\/regex\\/\\d+$/", undefined]);
  });

  it("resolves koa-route templates", async () => {
    const app = new Koa();
    const routes = observeMatchedRoutes(app);
    app.use(
      route.get("/legacy/:id", (ctx) => {
        ctx.body = "ok";
      }),
    );

    await sendRequests(app, ["/legacy/42"]);

    expect(routes).toEqual(["/legacy/:id"]);
  });
});
