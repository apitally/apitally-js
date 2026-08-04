import { H3, HTTPError } from "h3";
import type { ApitallyOptions } from "../../src/config.js";
import { apitallyPlugin } from "../../src/h3/index.js";
import { setConsumer } from "../../src/index.js";
import { WRITE_TOKEN } from "../utils.js";

// These fixtures must remain behaviorally aligned across integration suites.
export function buildAppFixture(options: ApitallyOptions = {}): H3 {
  const app = new H3({
    silent: true,
    plugins: [apitallyPlugin({ writeToken: WRITE_TOKEN, ...options })],
  });

  app.get("/items/:id", (event) => ({
    id: Number(event.context.params?.id),
    name: "Widget",
  }));
  app.post("/items", async (event) => {
    const body: unknown = await event.req.json();
    event.res.status = 201;
    return { received: body };
  });
  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/bad-request", () => {
    throw new HTTPError({ status: 400, message: "bad request" });
  });
  app.get("/error", () => {
    throw new Error("boom");
  });
  app.get("/consumer", () => {
    setConsumer({ identifier: "acme", name: "Acme Corp", group: "enterprise" });
    return { ok: true };
  });
  app.get("/stream", () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("chunk-1\n"));
        controller.enqueue(encoder.encode("chunk-2\n"));
        controller.enqueue(encoder.encode("chunk-3\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });

  const apiApp = new H3();
  apiApp.get("/nested/:key", (event) => ({ key: event.context.params?.key }));
  const versionApp = new H3();
  versionApp.get("/deep", () => ({ deep: true }));
  apiApp.mount("/v2", versionApp);
  app.mount("/api", apiApp);

  return app;
}
