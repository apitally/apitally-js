import type { IncomingMessage } from "node:http";
import express5, { type Express } from "express";
import express4 from "express4";
import { describe, expect, it } from "vitest";
import {
  beginRouteTracking,
  finishRouteTracking,
  installRouteCaptureFromApp,
  type RouteTrackingResult,
  resolveStartupPaths,
} from "../../src/express/routes.js";
import { withServer } from "../utils.js";

type ExpressModule = typeof express5;

interface TrackedApp {
  app: Express;
  requests: IncomingMessage[];
}

function createTrackedApp(expressModule: ExpressModule): TrackedApp {
  const app = expressModule();
  installRouteCaptureFromApp(app);
  const requests: IncomingMessage[] = [];
  app.use((req, _res, next) => {
    beginRouteTracking(req);
    requests.push(req);
    next();
  });
  return { app, requests };
}

// Fixtures whose mounts predate any capture installation, like routers
// assembled before the SDK loaded. Built at module scope so no test has
// installed the prototype patches yet.
function buildPreCaptureFixture(expressModule: ExpressModule): TrackedApp & {
  mountedBeforeCapture: ReturnType<ExpressModule["Router"]>;
} {
  const app = expressModule();
  const requests: IncomingMessage[] = [];
  app.use((req, _res, next) => {
    beginRouteTracking(req);
    requests.push(req);
    next();
  });
  const mountedBeforeCapture = expressModule.Router();
  app.use("/api", mountedBeforeCapture);
  return { app, requests, mountedBeforeCapture };
}
const preCaptureFixtures = {
  "express 5": buildPreCaptureFixture(express5),
  "express 4": buildPreCaptureFixture(express4),
};

async function driveAndResolveRoutes(
  fixture: TrackedApp,
  paths: string[],
): Promise<RouteTrackingResult[]> {
  await withServer(fixture.app, async (_server, baseUrl) => {
    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`);
      await response.arrayBuffer();
    }
  });
  return paths.map((path, index) =>
    finishRouteTracking(fixture.requests[index], path.split("?")[0]),
  );
}

const respondOk = (_req: unknown, res: { json: (body: object) => void }) => {
  res.json({ ok: true });
};

describe.each([
  ["express 5", express5],
  ["express 4", express4],
] as [keyof typeof preCaptureFixtures, ExpressModule][])(
  "express routes (%s)",
  (label, expressModule) => {
    it("captures verb, route, and mount registrations for the startup paths", () => {
      const { app } = createTrackedApp(expressModule);
      app.get("/items/:id", respondOk);
      app.post("/items", respondOk);
      app.route("/batch").get(respondOk).post(respondOk);
      const child = expressModule.Router();
      child.get("/deep", respondOk);
      const parent = expressModule.Router();
      parent.use("/child", child);
      app.use("/parent", parent);

      expect(resolveStartupPaths(app)).toEqual([
        { method: "GET", path: "/items/:id" },
        { method: "POST", path: "/items" },
        { method: "GET", path: "/batch" },
        { method: "POST", path: "/batch" },
        { method: "GET", path: "/parent/child/deep" },
      ]);
    });

    it("assembles route templates including mount prefixes for nested routers", async () => {
      const fixture = createTrackedApp(expressModule);
      const grandchild = expressModule.Router();
      grandchild.get("/deep/:x", respondOk);
      const child = expressModule.Router();
      child.get("/items/:id", respondOk);
      child.use("/nested/:nid", grandchild);
      fixture.app.use("/api", child);

      const results = await driveAndResolveRoutes(fixture, [
        "/api/items/42",
        "/api/nested/9/deep/1",
      ]);
      expect(results.map((result) => result.route)).toEqual([
        "/api/items/:id",
        "/api/nested/:nid/deep/:x",
      ]);
    });

    it("resolves the matching template for use registrations with array paths", async () => {
      const fixture = createTrackedApp(expressModule);
      const child = expressModule.Router();
      child.get("/x/:id", respondOk);
      fixture.app.use(["/a", "/b/:v"], child);

      const results = await driveAndResolveRoutes(fixture, [
        "/a/x/1",
        "/b/7/x/2",
      ]);
      expect(results.map((result) => result.route)).toEqual([
        "/a/x/:id",
        "/b/:v/x/:id",
      ]);
    });

    it("clears the route when the assembled template does not match the request path", async () => {
      const fixture = preCaptureFixtures[label];
      installRouteCaptureFromApp(fixture.app);
      fixture.mountedBeforeCapture.get("/items/:id", respondOk);

      const [result] = await driveAndResolveRoutes(fixture, ["/api/items/42"]);
      expect(result.route).toBeUndefined();
      expect(result.matchedUncapturedRegistration).toBe(true);
    });
  },
);

describe("express routes (express 4 syntax)", () => {
  it("normalizes inline regular expression parameters in captured templates", async () => {
    const fixture = createTrackedApp(express4);
    fixture.app.get("/re/:id(\\d+)", respondOk);

    expect(resolveStartupPaths(fixture.app)).toEqual([
      { method: "GET", path: "/re/:id" },
    ]);
    const [result] = await driveAndResolveRoutes(fixture, ["/re/42"]);
    expect(result.route).toBe("/re/:id");
  });
});

describe("express routes (express 5 syntax)", () => {
  it("filters pure wildcard segments from assembled route templates while keeping named wildcards in longer paths", async () => {
    const fixture = createTrackedApp(express5);
    const catchAllRouter = express5.Router();
    catchAllRouter.get("/{*splat}", respondOk);
    fixture.app.use("/files", catchAllRouter);
    fixture.app.get("/assets/{*path}", respondOk);

    const results = await driveAndResolveRoutes(fixture, [
      "/files/a/b",
      "/assets/img/logo.png",
    ]);
    expect(results.map((result) => result.route)).toEqual([
      "/files",
      "/assets/{*path}",
    ]);
  });
});
