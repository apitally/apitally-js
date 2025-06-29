import { ServerFactory } from "@adonisjs/core/factories/http";
import { ApplicationService } from "@adonisjs/core/types";
import { createServer } from "http";
import supertest from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApitallyProvider from "../../src/adonisjs/provider.js";
import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub } from "../utils.js";
import { createApp, createRoutes } from "./app.js";

describe("Middleware for AdonisJS", () => {
  let app: ApplicationService;
  let provider: ApitallyProvider;
  let client: ApitallyClient;
  let testAgent: supertest.Agent;

  beforeEach(async () => {
    mockApitallyHub();

    app = await createApp();
    provider = new ApitallyProvider(app);
    provider.register();

    const server = new ServerFactory().merge({ app }).create();
    const router = server.getRouter();
    createRoutes(router);
    app.container.bindValue("router", router);
    await server.boot();

    client = await app.container.make("apitallyClient");

    const httpServer = createServer(server.handle.bind(server));
    testAgent = supertest(httpServer);
  });

  it("Provider sets startup data", async () => {
    const spy = vi.spyOn(client, "setStartupData");
    await provider.ready();
    expect(spy).toHaveBeenCalledOnce();

    const startupData = spy.mock.lastCall?.[0];
    expect(startupData?.paths).toEqual([
      {
        method: "GET",
        path: "/hello",
      },
      {
        method: "GET",
        path: "/hello/:id",
      },
      {
        method: "POST",
        path: "/hello",
      },
      {
        method: "GET",
        path: "/error",
      },
    ]);
    expect(startupData?.versions["adonisjs"]).toBeDefined();
    expect(startupData?.versions["app"]).toBe("1.2.3");
    expect(startupData?.client).toBe("js:adonisjs");
  });

  it("Request counter", async () => {
    await testAgent.get("/hello?name=John&age=20").expect(200);
    await testAgent.get("/hello?name=Mary&age=19").expect(200);
    await testAgent.post("/hello").send({ name: "John", age: 20 }).expect(200);
    await testAgent.get("/error").expect(500);

    const requests = client.requestCounter.getAndResetRequests();
    expect(requests.length).toBe(3);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/hello" &&
          r.status_code === 200 &&
          r.request_size_sum === 0 &&
          r.response_size_sum > 0 &&
          r.request_count === 2,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "POST" &&
          r.path === "/hello" &&
          r.status_code === 200 &&
          r.consumer === "test" &&
          r.request_size_sum > 0 &&
          r.response_size_sum > 0 &&
          r.request_count === 1,
      ),
    ).toBe(true);
    expect(
      requests.some((r) => r.status_code === 500 && r.request_count === 1),
    ).toBe(true);
  });

  it("Request logger", async () => {
    const spy = vi.spyOn(client.requestLogger, "logRequest");
    let call;

    await testAgent.get("/hello?name=John&age=20").expect(200);
    expect(spy).toHaveBeenCalledOnce();
    call = spy.mock.calls[0];
    expect(call[0].method).toBe("GET");
    expect(call[0].path).toBe("/hello");
    expect(call[0].url).toMatch(
      /^http:\/\/127\.0\.0\.1(:\d+)?\/hello\?name=John&age=20$/,
    );
    expect(call[1].statusCode).toBe(200);
    expect(call[1].responseTime).toBeGreaterThan(0);
    expect(call[1].responseTime).toBeLessThan(1);
    expect(call[1].size).toBeGreaterThan(0);
    expect(call[1].headers).toContainEqual([
      "content-type",
      "text/plain; charset=utf-8",
    ]);
    expect(call[1].body).toBeInstanceOf(Buffer);
    expect(call[1].body!.toString()).toMatch(/^Hello John!/);
    spy.mockReset();

    await testAgent.post("/hello").send({ name: "John", age: 20 }).expect(200);
    expect(spy).toHaveBeenCalledOnce();
    call = spy.mock.calls[0];
    expect(call[0].method).toBe("POST");
    expect(call[0].path).toBe("/hello");
    expect(call[0].headers).toContainEqual([
      "content-type",
      "application/json",
    ]);
    expect(call[0].body).toBeInstanceOf(Buffer);
    expect(call[0].body!.toString()).toMatch(/^{"name":"John","age":20}$/);
    expect(call[1].body).toBeInstanceOf(Buffer);
    expect(call[1].body!.toString()).toMatch(/^Hello John!/);
  });

  it("Validation error counter", async () => {
    await testAgent.post("/hello").send({ name: "X", age: 1 }).expect(422);

    const validationErrors =
      client.validationErrorCounter.getAndResetValidationErrors();
    expect(validationErrors.length).toBe(2);
    expect(
      validationErrors.some(
        (e) =>
          e.loc[0] == "name" && e.type == "minLength" && e.error_count == 1,
      ),
    ).toBe(true);
    expect(
      validationErrors.some(
        (e) => e.loc[0] == "age" && e.type == "min" && e.error_count == 1,
      ),
    ).toBe(true);
  });

  it("Server error counter", async () => {
    await testAgent.get("/error").expect(500);

    const serverErrors = client.serverErrorCounter.getAndResetServerErrors();
    expect(serverErrors.length).toBe(1);
    expect(
      serverErrors.some(
        (e) =>
          e.type === "Error" &&
          e.msg === "test" &&
          e.traceback &&
          e.error_count === 1,
      ),
    ).toBe(true);
  });

  afterEach(async () => {
    await provider.shutdown();
  });
});
