// Mixed-loading child fixture: loads the built package by self-reference
// through both the ESM entry (import) and the CJS entry (require), wraps one
// Express app through both copies, and serves one request whose handler logs
// via winston and pino. DIST_WRAP_ORDER picks which entry wraps first;
// shutdown runs through the other entry. The parent decodes the payloads the
// OTLP sink received.
import { once } from "node:events";
import { createRequire } from "node:module";
import { startOtlpSink } from "./distOtlpSink.mjs";

const require = createRequire(import.meta.url);

const sink = await startOtlpSink(process.env.DIST_SINK_DIR);
process.env.APITALLY_OTLP_ENDPOINT = sink.url;

const esmEntry = await import("apitally");
const cjsEntry = require("apitally");
const express = require("express");
const winston = require("winston");
const pino = require("pino");

const app = express();
const [firstEntry, secondEntry] =
  process.env.DIST_WRAP_ORDER === "cjs"
    ? [cjsEntry, esmEntry]
    : [esmEntry, cjsEntry];
firstEntry.useApitally(app);
secondEntry.useApitally(app);

const winstonLogger = winston.createLogger({
  transports: [new winston.transports.Console({ silent: true })],
});
const pinoLogger = pino({}, { write: () => {} });

app.get("/items/:id", (_req, res) => {
  winstonLogger.info("winston message");
  pinoLogger.info("pino message");
  res.json({ ok: true });
});

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const response = await fetch(
  `http://127.0.0.1:${server.address().port}/items/7`,
);
const body = await response.json();
await new Promise((resolve) => {
  setImmediate(resolve);
});

await new Promise((resolve) => {
  server.close(resolve);
});
await secondEntry.shutdown();
await sink.close();
process.stdout.write(`${JSON.stringify({ status: response.status, body })}\n`);
