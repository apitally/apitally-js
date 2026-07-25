import { Hono } from "hono";
import type { ApitallyOptions } from "../../src/config.js";
import { useApitally } from "../../src/hono/index.js";
import { setConsumer } from "../../src/spanProcessor.js";
import { WRITE_TOKEN } from "../utils.js";

// These fixtures must remain behaviorally aligned across adapter suites.
export function buildAppFixture(options: ApitallyOptions = {}): Hono {
  const app = new Hono();
  useApitally(app, { writeToken: WRITE_TOKEN, ...options });

  app.get("/items/:id", (c) =>
    c.json({ id: Number(c.req.param("id")), name: "Widget" }),
  );
  app.post("/items", async (c) => {
    const body: unknown = await c.req.json();
    return c.json({ received: body }, 201);
  });
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/error", () => {
    throw new Error("boom");
  });
  app.get("/consumer", (c) => {
    setConsumer({ identifier: "acme", name: "Acme Corp", group: "enterprise" });
    return c.json({ ok: true });
  });
  app.get("/stream", (c) => {
    const encoder = new TextEncoder();
    // `hold=1` keeps the stream open until the client disconnects in abort scenarios.
    const holdOpen = c.req.query("hold") === "1";
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("chunk-1\n"));
        controller.enqueue(encoder.encode("chunk-2\n"));
        controller.enqueue(encoder.encode("chunk-3\n"));
        if (!holdOpen) {
          controller.close();
        }
      },
    });
    return c.newResponse(body, 200, { "content-type": "text/plain" });
  });

  const apiApp = new Hono();
  apiApp.get("/nested/:key", (c) => c.json({ key: c.req.param("key") }));
  const versionApp = new Hono();
  versionApp.get("/deep", (c) => c.json({ deep: true }));
  apiApp.route("/v2", versionApp);
  app.route("/api", apiApp);

  return app;
}
