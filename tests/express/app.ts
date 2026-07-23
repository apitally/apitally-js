import { once } from "node:events";
import express, { type Express } from "express";
import type { ApitallyOptions } from "../../src/config.js";
import { useApitally } from "../../src/express/index.js";
import { setConsumer } from "../../src/spanProcessor.js";
import { WRITE_TOKEN } from "../utils.js";

// The uniform app fixture driven by every framework's integration suite:
// an item GET with a path parameter, an item POST consuming a JSON body, a
// health check, a synchronously throwing error route, a consumer route, a
// streaming route, and a mounted sub-router with a nested mount.
export function buildAppFixture(options: ApitallyOptions = {}): Express {
  const app = express();
  useApitally(app, { writeToken: WRITE_TOKEN, ...options });

  app.get("/items/:id", (req, res) => {
    res.json({ id: Number(req.params.id), name: "Widget" });
  });
  app.post("/items", express.json(), (req, res) => {
    res.status(201).json({ received: req.body as unknown });
  });
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/error", () => {
    throw new Error("boom");
  });
  app.get("/consumer", (_req, res) => {
    setConsumer({ identifier: "acme", name: "Acme Corp", group: "enterprise" });
    res.json({ ok: true });
  });
  app.get("/stream", async (req, res) => {
    res.setHeader("content-type", "text/plain");
    res.write("chunk-1\n");
    res.write("chunk-2\n");
    res.write("chunk-3\n");
    if (req.query.hold === "1") {
      // Stays open until the client disconnects, for abort scenarios
      await once(res, "close");
      return;
    }
    res.end();
  });

  const apiRouter = express.Router();
  apiRouter.get("/nested/:key", (req, res) => {
    res.json({ key: req.params.key });
  });
  const versionRouter = express.Router();
  versionRouter.get("/deep", (_req, res) => {
    res.json({ deep: true });
  });
  apiRouter.use("/v2", versionRouter);
  app.use("/api", apiRouter);

  return app;
}
