// Express-generator-shape child fixture: the register entry is the first
// import, a router is assembled at module scope, and useApitally runs after
// the app is created; the exported span must carry the full route template
// including the mount prefix.
import "apitally/express/register";

import { once } from "node:events";
import { shutdown, useApitally } from "apitally";
import express from "express";
import { startOtlpSink } from "./distOtlpSink.mjs";

const router = express.Router();
router.get("/items/:id", (_req, res) => {
  res.json({ ok: true });
});

const sink = await startOtlpSink(process.env.DIST_SINK_DIR);
process.env.APITALLY_OTLP_ENDPOINT = sink.url;

const app = express();
app.use("/api", router);
useApitally(app);

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const response = await fetch(
  `http://127.0.0.1:${server.address().port}/api/items/7`,
);
await response.arrayBuffer();
await new Promise((resolve) => {
  setImmediate(resolve);
});

await new Promise((resolve) => {
  server.close(resolve);
});
await shutdown();
await sink.close();
process.stdout.write(`${JSON.stringify({ status: response.status })}\n`);
