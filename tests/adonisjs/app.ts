import { Readable } from "node:stream";
import { AppFactory } from "@adonisjs/core/factories/app";
import { BodyParserMiddlewareFactory } from "@adonisjs/core/factories/bodyparser";
import { ServerFactory } from "@adonisjs/core/factories/http";
import { ExceptionHandler, type HttpContext } from "@adonisjs/core/http";
import type { ApplicationService, HttpServerService } from "@adonisjs/core/types";

import { captureException } from "../../src/adonisjs/index.js";
import ApitallyMiddleware from "../../src/adonisjs/middleware.js";
import ApitallyProvider from "../../src/adonisjs/provider.js";
import type { ApitallyOptions } from "../../src/config.js";
import { setConsumer } from "../../src/index.js";
import { WRITE_TOKEN } from "../utils.js";

const APP_ROOT = new URL("./tmp/", import.meta.url);

export interface AppFixture {
  app: ApplicationService;
  server: HttpServerService;
}

export async function buildAppFixture(
  options: ApitallyOptions = {},
  trustProxy = false,
): Promise<AppFixture> {
  const app = new AppFactory().merge({ environment: "web" }).create(APP_ROOT) as ApplicationService;
  app.useConfig({ apitally: { writeToken: WRITE_TOKEN, ...options } });
  await app.init();
  app.rcFile.providers.push({
    file: async () => ({ default: ApitallyProvider }),
    environment: ["web"],
  });

  const server = new ServerFactory()
    .merge({ app, config: { trustProxy: () => trustProxy } })
    .create();
  const router = server.getRouter();
  app.container.bindValue("router", router);
  server.use([async () => ({ default: ApitallyMiddleware })]);
  server.errorHandler(async () => ({ default: FixtureExceptionHandler }));

  const bodyParser = new BodyParserMiddlewareFactory().create();
  router.get("/items/:id", ({ params }) => ({ id: Number(params.id), name: "Widget" }));
  router
    .post("/items", ({ request, response }) => {
      response.status(201);
      return { received: request.body() };
    })
    .middleware(bodyParser.handle.bind(bodyParser));
  router.get("/healthz", () => ({ status: "ok" }));
  router.get("/error", () => {
    throw new Error("boom");
  });
  // The error shape VineJS throws; the exception handler renders it as `{ errors }`.
  router.post("/validate", () => {
    throw Object.assign(new Error("Validation failure"), {
      code: "E_VALIDATION_ERROR",
      status: 422,
      messages: [{ message: "The name field must be defined", rule: "required", field: "name" }],
    });
  });
  router.get("/consumer", () => {
    setConsumer({ identifier: "acme", name: "Acme Corp", group: "enterprise" });
    return { ok: true };
  });
  router.get("/stream", ({ response }) => {
    response.type("text/plain");
    response.stream(Readable.from(["chunk-1\n", "chunk-2\n", "chunk-3\n"]));
  });
  router
    .group(() => {
      router.get("/nested/:key", ({ params }) => ({ key: params.key }));
      router.group(() => router.get("/deep", () => ({ deep: true }))).prefix("/v2");
    })
    .prefix("/api");

  await app.boot();
  await server.boot();
  await app.start(() => {});
  return { app, server };
}

class FixtureExceptionHandler extends ExceptionHandler {
  async handle(error: unknown, ctx: HttpContext): Promise<unknown> {
    const result = await super.handle(error, ctx);
    captureException(error, ctx);
    return result;
  }
}
