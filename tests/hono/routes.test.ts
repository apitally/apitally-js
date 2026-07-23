import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  type MatchedRouteResult,
  resolveMatchedRoute,
  resolveStartupPaths,
} from "../../src/hono/routes.js";

interface ObservedApp {
  app: Hono;
  results: MatchedRouteResult[];
}

// Mirrors the adapter's setup shape: the observing middleware registers first,
// so routes registered after it compose behind it.
function createObservedApp(): ObservedApp {
  const app = new Hono();
  const results: MatchedRouteResult[] = [];
  app.use(async (c, next) => {
    await next();
    results.push(resolveMatchedRoute(c));
  });
  return { app, results };
}

const respondOk = (c: Context) => c.json({ ok: true });

describe("hono routes", () => {
  it("resolves route templates including mount prefixes for nested sub-app mounts with path parameters", async () => {
    const { app, results } = createObservedApp();
    const child = new Hono();
    child.get("/items/:id", respondOk);
    const grandchild = new Hono();
    grandchild.get("/deep/:x", respondOk);
    child.route("/nested/:nid", grandchild);
    app.route("/api", child);

    await app.request("/api/items/42");
    await app.request("/api/nested/9/deep/1");
    expect(results).toEqual([
      { route: "/api/items/:id", matched: true },
      { route: "/api/nested/:nid/deep/:x", matched: true },
    ]);
  });

  it("resolves the route handler's template, never a middleware path, including when middleware responds without calling next", async () => {
    const { app, results } = createObservedApp();
    app.use("/things/*", async (_c, next) => {
      await next();
    });
    app.use("/blocked/*", async (c, _next) => c.json({ denied: true }, 401));
    app.get("/things/:id", respondOk);
    app.get("/blocked/:id", respondOk);

    await app.request("/things/7");
    const blockedResponse = await app.request("/blocked/7");
    expect(blockedResponse.status).toBe(401);
    expect(results).toEqual([
      { route: "/things/:id", matched: true },
      { route: "/blocked/:id", matched: true },
    ]);
  });

  it("reports no match for unmatched requests, including requests matched only by middleware", async () => {
    const { app, results } = createObservedApp();
    app.use("/guarded/*", async (_c, next) => {
      await next();
    });
    app.get("/known", respondOk);

    await app.request("/unknown");
    await app.request("/guarded/anything");
    expect(results).toEqual([{ matched: false }, { matched: false }]);
  });

  it("enumerates registered routes for the startup paths, filtering middleware entries and duplicates", () => {
    const app = new Hono();
    app.use(async (_c, next) => {
      await next();
    });
    app.get("/items/:id", respondOk);
    app.get("/items/:id", respondOk);
    app.post("/items", respondOk);
    const subApp = new Hono();
    subApp.get("/deep", respondOk);
    app.route("/api", subApp);

    expect(resolveStartupPaths(app)).toEqual([
      { method: "GET", path: "/items/:id" },
      { method: "POST", path: "/items" },
      { method: "GET", path: "/api/deep" },
    ]);
  });
});
