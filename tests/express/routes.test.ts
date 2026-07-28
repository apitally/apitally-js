import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import {
  beginRouteTracking,
  finishRouteTracking,
  installRouteCaptureFromApp,
  resolveStartupPaths,
} from "../../src/express/routes.js";
import { withServer } from "../utils.js";

const { version: expressVersion } = createRequire(import.meta.url)("express/package.json") as {
  version: string;
};

interface RouteFixture {
  app: Express;
  requests: IncomingMessage[];
}

function createRouteFixture(): RouteFixture {
  const app = express();
  installRouteCaptureFromApp(app);
  const requests: IncomingMessage[] = [];
  app.use((req, _res, next) => {
    beginRouteTracking(req);
    requests.push(req);
    next();
  });
  return { app, requests };
}

// This router is mounted at module scope, before the SDK installs capture patches.
const preCaptureApp = express();
const preCaptureRequests: IncomingMessage[] = [];
preCaptureApp.use((req, _res, next) => {
  beginRouteTracking(req);
  preCaptureRequests.push(req);
  next();
});
const preCaptureMountedRouter = express.Router();
preCaptureApp.use("/api", preCaptureMountedRouter);
const preCaptureFixture = {
  app: preCaptureApp,
  requests: preCaptureRequests,
  mountedRouter: preCaptureMountedRouter,
};

async function sendRequestsAndResolveRoutes(fixture: RouteFixture, requestPaths: string[]) {
  const firstRequestIndex = fixture.requests.length;
  await withServer(fixture.app, async (_server, baseUrl) => {
    for (const requestPath of requestPaths) {
      const response = await fetch(`${baseUrl}${requestPath}`);
      await response.arrayBuffer();
    }
  });
  return requestPaths.map((requestPath, index) =>
    finishRouteTracking(fixture.requests[firstRequestIndex + index], requestPath.split("?")[0]),
  );
}

async function expectPureCatchAllSegmentOmitted(catchAllPath: string): Promise<void> {
  const fixture = createRouteFixture();
  const catchAllRouter = express.Router();
  catchAllRouter.get(catchAllPath, respondOk);
  fixture.app.use("/files", catchAllRouter);

  const [routeResult] = await sendRequestsAndResolveRoutes(fixture, ["/files/a/b"]);
  expect(routeResult).toEqual({ route: "/files", matchedUncapturedRegistration: false });
}

async function expectNamedWildcardTemplatePreserved(wildcardPath: string): Promise<void> {
  const fixture = createRouteFixture();
  fixture.app.get(wildcardPath, respondOk);

  const [routeResult] = await sendRequestsAndResolveRoutes(fixture, ["/assets/img/logo.png"]);
  expect(routeResult).toEqual({ route: wildcardPath, matchedUncapturedRegistration: false });
}

const respondOk = (_req: unknown, res: { json: (body: object) => void }) => {
  res.json({ ok: true });
};

describe("express routes", () => {
  it("enumerates registered route templates at startup", () => {
    const { app } = createRouteFixture();
    app.get("/items/:id", respondOk);
    app.get("/items/:id", respondOk);
    app.post("/items", respondOk);
    const child = express.Router();
    child.get("/deep", respondOk);
    app.use("/api", child);

    expect(resolveStartupPaths(app)).toEqual([
      { method: "GET", path: "/items/:id" },
      { method: "POST", path: "/items" },
      { method: "GET", path: "/api/deep" },
    ]);
  });

  it("resolves route templates with nested mount prefixes", async () => {
    const fixture = createRouteFixture();
    const grandchild = express.Router();
    grandchild.get("/deep/:x", respondOk);
    const child = express.Router();
    child.get("/items/:id", respondOk);
    child.use("/nested/:nid", grandchild);
    fixture.app.use("/api", child);

    const routeResults = await sendRequestsAndResolveRoutes(fixture, [
      "/api/items/42",
      "/api/nested/9/deep/1",
    ]);
    expect(routeResults).toEqual([
      {
        route: "/api/items/:id",
        matchedUncapturedRegistration: false,
      },
      {
        route: "/api/nested/:nid/deep/:x",
        matchedUncapturedRegistration: false,
      },
    ]);
  });

  it("enumerates route templates from chained methods, pathless routers, and mounted sub-apps", () => {
    const { app } = createRouteFixture();
    app.route("/batch").get(respondOk).post(respondOk);
    const child = express.Router();
    child.get("/deep", respondOk);
    const parent = express.Router();
    parent.use("/child", child);
    const pathless = express.Router();
    pathless.get("/direct", respondOk);
    parent.use(pathless);
    app.use("/parent", parent);
    const subApp = express();
    subApp.get("/things/:id", respondOk);
    app.use("/sub", subApp);

    expect(resolveStartupPaths(app)).toEqual([
      { method: "GET", path: "/batch" },
      { method: "POST", path: "/batch" },
      { method: "GET", path: "/parent/child/deep" },
      { method: "GET", path: "/parent/direct" },
      { method: "GET", path: "/sub/things/:id" },
    ]);
  });

  it("resolves the matching template for use registrations with array paths", async () => {
    const fixture = createRouteFixture();
    const child = express.Router();
    child.get("/x/:id", respondOk);
    fixture.app.use(["/a", "/b/:v"], child);

    const routeResults = await sendRequestsAndResolveRoutes(fixture, ["/a/x/1", "/b/7/x/2"]);
    expect(routeResults).toEqual([
      { route: "/a/x/:id", matchedUncapturedRegistration: false },
      { route: "/b/:v/x/:id", matchedUncapturedRegistration: false },
    ]);
  });

  it("reports an uncaptured registration when a router was mounted before route capture", async () => {
    installRouteCaptureFromApp(preCaptureFixture.app);
    preCaptureFixture.mountedRouter.get("/items/:id", respondOk);

    const [routeResult] = await sendRequestsAndResolveRoutes(preCaptureFixture, ["/api/items/42"]);
    expect(routeResult).toEqual({ matchedUncapturedRegistration: true });
  });

  it.runIf(expressVersion.startsWith("4."))(
    "omits pure catch-all templates while preserving named wildcards in longer Express 4 routes",
    async () => {
      await expectPureCatchAllSegmentOmitted("*");
      await expectNamedWildcardTemplatePreserved("/assets/:path*");
    },
  );

  it.runIf(expressVersion.startsWith("5."))(
    "omits pure catch-all templates while preserving named wildcards in longer Express 5 routes",
    async () => {
      await expectPureCatchAllSegmentOmitted("/{*splat}");
      await expectNamedWildcardTemplatePreserved("/assets/{*path}");
    },
  );
});
