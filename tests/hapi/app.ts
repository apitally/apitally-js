import { Readable } from "node:stream";
import { server as createServer, type Server } from "@hapi/hapi";
import type { ApitallyOptions } from "../../src/config.js";
import { apitallyPlugin } from "../../src/hapi/index.js";
import { setConsumer } from "../../src/index.js";
import { WRITE_TOKEN } from "../utils.js";

// These fixtures must remain behaviorally aligned across integration suites.
export async function buildAppFixture(options: ApitallyOptions = {}): Promise<Server> {
  const server = createServer({ host: "127.0.0.1" });
  await server.register(apitallyPlugin({ writeToken: WRITE_TOKEN, ...options }));

  server.route([
    {
      method: "GET",
      path: "/items/{id}",
      handler: (request) => ({ id: Number(request.params.id), name: "Widget" }),
    },
    {
      method: "POST",
      path: "/items",
      handler: (request, h) => h.response({ received: request.payload }).code(201),
    },
    { method: "GET", path: "/healthz", handler: () => ({ status: "ok" }) },
    {
      method: "GET",
      path: "/error",
      handler: () => {
        throw new Error("boom");
      },
    },
    {
      method: "GET",
      path: "/validated",
      options: {
        validate: {
          query: () => {
            throw new Error("invalid query");
          },
        },
      },
      handler: () => ({ ok: true }),
    },
    {
      method: "GET",
      path: "/consumer",
      handler: () => {
        setConsumer({ identifier: "acme", name: "Acme Corp", group: "enterprise" });
        return { ok: true };
      },
    },
    {
      method: "GET",
      path: "/stream",
      handler: (_request, h) =>
        h
          .response(Readable.from(["chunk-1\n", "chunk-2\n", "chunk-3\n"], { objectMode: false }))
          .type("text/plain"),
    },
    {
      method: "GET",
      path: "/logs",
      handler: (request) => {
        request.log(["ERROR"], new Error("native failure"));
        request.log([], "plain message");
        return { ok: true };
      },
    },
  ]);

  await server.register(
    {
      name: "fixture-api",
      register: async (api) => {
        api.route({
          method: "GET",
          path: "/nested/{key}",
          handler: (request) => ({ key: request.params.key }),
        });
        await api.register(
          {
            name: "fixture-api-v2",
            register: (version) => {
              version.route({ method: "GET", path: "/deep", handler: () => ({ deep: true }) });
            },
          },
          { routes: { prefix: "/v2" } },
        );
      },
    },
    { routes: { prefix: "/api" } },
  );

  return server;
}
