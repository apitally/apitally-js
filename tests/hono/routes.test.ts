import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { resolveMatchedRoute, resolveStartupPaths } from "../../src/hono/routes.js";

interface RouteFixture {
  app: Hono;
  routes: (string | undefined)[];
}

// Mirrors the adapter's setup shape: the observing middleware registers first,
// so routes registered after it compose behind it.
function createRouteFixture(): RouteFixture {
  const app = new Hono();
  const routes: (string | undefined)[] = [];
  app.use(async (context, next) => {
    await next();
    routes.push(resolveMatchedRoute(context));
  });
  return { app, routes };
}

async function sendRequestsAndResolveRoutes(
  fixture: RouteFixture,
  requestPaths: string[],
): Promise<(string | undefined)[]> {
  const firstRouteIndex = fixture.routes.length;
  for (const requestPath of requestPaths) {
    const response = await fixture.app.request(requestPath);
    await response.arrayBuffer();
  }
  return fixture.routes.slice(firstRouteIndex);
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

    const routes = await sendRequestsAndResolveRoutes(fixture, [
      "/api/items/42",
      "/api/nested/9/deep/1",
    ]);
    expect(routes).toEqual(["/api/items/:id", "/api/nested/:nid/deep/:x"]);
  });

  it("resolves route handler templates instead of middleware paths", async () => {
    const fixture = createRouteFixture();
    fixture.app.use("/things/*", async (_context, next) => {
      await next();
    });
    fixture.app.use("/blocked/*", async (context, _next) => context.json({ denied: true }, 401));
    fixture.app.get("/things/:id", respondOk);
    fixture.app.get("/blocked/:id", respondOk);

    const thingsResponse = await fixture.app.request("/things/7");
    await thingsResponse.arrayBuffer();
    const blockedResponse = await fixture.app.request("/blocked/7");
    await blockedResponse.arrayBuffer();
    expect(blockedResponse.status).toBe(401);
    expect(fixture.routes).toEqual(["/things/:id", "/blocked/:id"]);
  });

  it("reports no match for unmatched and middleware-only requests", async () => {
    const fixture = createRouteFixture();
    fixture.app.use("/guarded/*", async (_context, next) => {
      await next();
    });
    fixture.app.get("/known", respondOk);

    const routes = await sendRequestsAndResolveRoutes(fixture, ["/unknown", "/guarded/anything"]);
    expect(routes).toEqual([undefined, undefined]);
  });
});
