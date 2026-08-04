import { H3 } from "h3";
import { describe, expect, it } from "vitest";
import { resolveStartupPaths } from "../../src/h3/routes.js";

describe("h3 routes", () => {
  it("enumerates registered route templates with mount prefixes at startup", () => {
    const app = new H3();
    app.get("/items/:id", () => ({ ok: true }));
    app.post("/items", () => ({ ok: true }));
    app.head("/items", () => null);
    app.options("/items", () => null);
    app.all("/all", () => ({ ok: true }));
    const child = new H3();
    child.get("/", () => ({ ok: true }));
    child.get("/nested/:key", () => ({ ok: true }));
    const grandchild = new H3();
    grandchild.get("/deep", () => ({ ok: true }));
    child.mount("/v2", grandchild);
    app.mount("/api", child);

    expect(resolveStartupPaths(app)).toEqual([
      { method: "GET", path: "/items/:id" },
      { method: "POST", path: "/items" },
      { method: "GET", path: "/api" },
      { method: "GET", path: "/api/nested/:key" },
      { method: "GET", path: "/api/v2/deep" },
    ]);
  });
});
