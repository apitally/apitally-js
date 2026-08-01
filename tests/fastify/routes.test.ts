import { fastify } from "fastify";
import { describe, expect, it } from "vitest";
import { addStartupPaths, resolveRequestRoute } from "../../src/fastify/routes.js";
import type { RoutePath } from "../../src/startup.js";

describe("fastify routes", () => {
  it("enumerates registered route templates at startup", async () => {
    const app = fastify();
    const paths: RoutePath[] = [];
    app.addHook("onRoute", (routeOptions) => {
      addStartupPaths(paths, routeOptions);
    });
    app.route({
      method: ["GET", "POST"],
      url: "/items/:id",
      handler: () => ({ ok: true }),
    });
    app.register(
      (child, _options, done) => {
        child.get("/deep", () => ({ ok: true }));
        done();
      },
      { prefix: "/api" },
    );

    await app.ready();
    expect(paths).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/items/:id" },
        { method: "POST", path: "/items/:id" },
        { method: "GET", path: "/api/deep" },
      ]),
    );
    await app.close();
  });

  it("resolves prefixed route templates and reports no match for unmatched requests", async () => {
    const app = fastify();
    const routes: (string | undefined)[] = [];
    app.addHook("onRequest", (request, _reply, done) => {
      routes.push(resolveRequestRoute(request));
      done();
    });
    app.register(
      (child, _options, done) => {
        child.get<{ Params: { id: string } }>("/items/:id", (request) => ({
          id: request.params.id,
        }));
        done();
      },
      { prefix: "/api" },
    );

    const matched = await app.inject("/api/items/7");
    const unmatched = await app.inject("/unknown");
    expect(matched.statusCode).toBe(200);
    expect(unmatched.statusCode).toBe(404);
    expect(routes).toEqual(["/api/items/:id", undefined]);
    await app.close();
  });
});
