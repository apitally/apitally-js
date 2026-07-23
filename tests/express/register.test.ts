// The documented Express setup: the register entry imported on the first
// line, before any module assembles routers at module scope.
import "../../src/express/register.js";

import express from "express";
import { describe, expect, it } from "vitest";
import { useApitally } from "../../src/express/index.js";
import { decodedAttributes, decodedLogRecords } from "../stubOtlpServer.js";
import {
  captureStderr,
  prepareFirstRequestActivation,
  readActivationSpans,
  readLogsExportFromSpool,
  requireActivationHandles,
  WRITE_TOKEN,
  withServer,
} from "../utils.js";

// Assembled at module scope before useApitally runs, like a route module in
// an express-generator layout.
const moduleScopeRouter = express.Router();
moduleScopeRouter.get("/items/:id", (_req, res) => {
  res.json({ ok: true });
});

describe("express register", () => {
  it("captures routes registered at module scope before useApitally and exports full route templates", async () => {
    const lines = captureStderr();
    prepareFirstRequestActivation();
    const app = express();
    app.use("/api", moduleScopeRouter);
    useApitally(app, { writeToken: WRITE_TOKEN });
    await withServer(app, async (_server, baseUrl) => {
      const response = await fetch(`${baseUrl}/api/items/7`);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });

    const spans = await readActivationSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /api/items/:id");
    expect(decodedAttributes(spans[0].attributes)["http.route"]).toBe(
      "/api/items/:id",
    );

    const handles = requireActivationHandles();
    const logRecords = decodedLogRecords(
      await readLogsExportFromSpool(handles.loggerProvider, handles.spool),
    );
    expect(logRecords).toHaveLength(1);
    expect(logRecords[0].eventName).toBe("apitally.app.startup");
    const startupPayload = JSON.parse(
      logRecords[0].body?.stringValue ?? "",
    ) as { paths: { method: string; path: string }[] };
    expect(startupPayload.paths).toEqual([
      { method: "GET", path: "/api/items/:id" },
    ]);
    expect(lines).toEqual([]);
  });
});
