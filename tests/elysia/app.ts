import { type AnyElysia, Elysia, t } from "elysia";
import type { ApitallyOptions } from "../../src/config.js";
import { apitallyPlugin } from "../../src/elysia/index.js";
import { setConsumer } from "../../src/index.js";
import { WRITE_TOKEN } from "../utils.js";

// These fixtures must remain behaviorally aligned across integration suites.
export function buildAppFixture(options: ApitallyOptions = {}): AnyElysia {
  return new Elysia()
    .use(apitallyPlugin({ writeToken: WRITE_TOKEN, ...options }))
    .get("/items/:id", ({ params }) => ({
      id: Number(params.id),
      name: "Widget",
    }))
    .post("/items", ({ body, set }) => {
      set.status = 201;
      return { received: body };
    })
    .get("/healthz", () => ({ status: "ok" }))
    .get("/bad-request", () => {
      throw Object.assign(new Error("bad request"), { status: 400 });
    })
    .get("/error", () => {
      throw new Error("boom");
    })
    .post("/validate", () => ({ ok: true }), { body: t.Object({ name: t.String() }) })
    .get("/consumer", () => {
      setConsumer({ identifier: "acme", name: "Acme Corp", group: "enterprise" });
      return { ok: true };
    })
    .get("/stream", () => {
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
    })
    .group("/api", (app) =>
      app
        .get("/nested/:key", ({ params }) => ({ key: params.key }))
        .group("/v2", (versionApp) => versionApp.get("/deep", () => ({ deep: true }))),
    );
}
