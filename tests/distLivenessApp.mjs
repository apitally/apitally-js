// Process-liveness child fixture: boots an Express app with useApitally,
// serves one request, and closes the server. It must then exit on its own --
// no shutdown() and no process.exit() -- because every SDK timer is unref'd.
import { once } from "node:events";
import { useApitally } from "apitally";
import express from "express";

const app = express();
useApitally(app);
app.get("/items/:id", (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const response = await fetch(
  `http://127.0.0.1:${server.address().port}/items/3`,
);
await response.arrayBuffer();
await new Promise((resolve) => {
  server.close(resolve);
});
process.stdout.write(`${JSON.stringify({ status: response.status })}\n`);
