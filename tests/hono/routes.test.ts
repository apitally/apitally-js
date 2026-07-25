import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  type MatchedRouteResult,
  resolveMatchedRoute,
  resolveStartupPaths,
} from "../../src/hono/routes.js";

interface RouteFixture {
  app: Hono;
  routeResults: MatchedRouteResult[];
}

// Mirrors the adapter's setup shape: the observing middleware registers first,
// so routes registered after it compose behind it.
function createRouteFixture(): RouteFixture {
  const app = new Hono();
  const routeResults: MatchedRouteResult[] = [];
  app.use(async (context, next) => {
    await next();
    routeResults.push(resolveMatchedRoute(context));
  });
  return { app, routeResults };
}

async function driveAndResolveRoutes(
  fixture: RouteFixture,
  requestPaths: string[],
): Promise<MatchedRouteResult[]> {
  const firstRouteResultIndex = fixture.routeResults.length;
  for (const requestPath of requestPaths) {
    const response = await fixture.app.request(requestPath);
    await response.arrayBuffer();
  }
  return fixture.routeResults.slice(firstRouteResultIndex);
}

const respondOk = (context: Context) => context.json({ ok: true });

describe("hono routes", () => {
  it("enumerates registered route templates at startup", () => {
    const { app } = createRouteFixture();
    app.get("/items/:id", respondOk);
    app.get("/items/:id", respondOk);
    app.post("/items", respondOk);
    const child = new Hono();
    child.get("/deep", respondOk);
    app.route("/api", child);

    expect(resolveStartupPaths(app)).toEqual([
      { method: "GET", path: "/items/:id" },
      { method: "POST", path: "/items" },
      { method: "GET", path: "/api/deep" },
    ]);
  });

  it("resolves route templates with nested mount prefixes", async () => {
    const fixture = createRouteFixture();
    const grandchild = new Hono();
    grandchild.get("/deep/:x", respondOk);
    const child = new Hono();
    child.get("/items/:id", respondOk);
    child.route("/nested/:nid", grandchild);
    fixture.app.route("/api", child);

    const routeResults = await driveAndResolveRoutes(fixture, [
      "/api/items/42",
      "/api/nested/9/deep/1",
    ]);
    expect(routeResults).toEqual([
      { route: "/api/items/:id" },
      { route: "/api/nested/:nid/deep/:x" },
    ]);
  });

  it("resolves route handler templates instead of middleware paths", async () => {
    const fixture = createRouteFixture();
    fixture.app.use("/things/*", async (_context, next) => {
      await next();
    });
    fixture.app.use("/blocked/*", async (context, _next) =>
      context.json({ denied: true }, 401),
    );
    fixture.app.get("/things/:id", respondOk);
    fixture.app.get("/blocked/:id", respondOk);

    const thingsResponse = await fixture.app.request("/things/7");
    await thingsResponse.arrayBuffer();
    const blockedResponse = await fixture.app.request("/blocked/7");
    await blockedResponse.arrayBuffer();
    expect(blockedResponse.status).toBe(401);
    expect(fixture.routeResults).toEqual([
      { route: "/things/:id" },
      { route: "/blocked/:id" },
    ]);
  });

  it("reports no match for unmatched and middleware-only requests", async () => {
    const fixture = createRouteFixture();
    fixture.app.use("/guarded/*", async (_context, next) => {
      await next();
    });
    fixture.app.get("/known", respondOk);

    const routeResults = await driveAndResolveRoutes(fixture, [
      "/unknown",
      "/guarded/anything",
    ]);
    expect(routeResults).toEqual([{}, {}]);
  });
});
