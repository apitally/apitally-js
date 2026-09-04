import { Readable } from "node:stream";
import { type FastifyInstance, fastify } from "fastify";
import type { ApitallyOptions } from "../../src/config.js";
import { useApitally } from "../../src/fastify/index.js";
import { setConsumer } from "../../src/index.js";
import { WRITE_TOKEN } from "../utils.js";

// These fixtures must remain behaviorally aligned across integration suites.
export function buildAppFixture(options: ApitallyOptions = {}): FastifyInstance {
  const app = fastify();
  useApitally(app, { writeToken: WRITE_TOKEN, ...options });

  app.get<{ Params: { id: string } }>("/items/:id", (request) => ({
    id: Number(request.params.id),
    name: "Widget",
  }));
  app.post<{ Body: unknown }>("/items", (request, reply) => {
    reply.code(201);
    return { received: request.body };
  });
  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/error", () => {
    throw new Error("boom");
  });
  app.post(
    "/validate",
    {
      schema: {
        body: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
    },
    () => ({ ok: true }),
  );
  app.get("/consumer", () => {
    setConsumer({ identifier: "acme", name: "Acme Corp", group: "enterprise" });
    return { ok: true };
  });
  app.get("/stream", (_request, reply) => {
    reply.type("text/plain");
    return reply.send(Readable.from(["chunk-1\n", "chunk-2\n", "chunk-3\n"]));
  });

  app.register(
    (api, _options, done) => {
      api.get<{ Params: { key: string } }>("/nested/:key", (request) => ({
        key: request.params.key,
      }));
      api.register(
        (version, _versionOptions, versionDone) => {
          version.get("/deep", () => ({ deep: true }));
          versionDone();
        },
        { prefix: "/v2" },
      );
      done();
    },
    { prefix: "/api" },
  );

  return app;
}
