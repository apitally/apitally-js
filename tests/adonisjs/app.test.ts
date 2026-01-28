import { ServerFactory } from "@adonisjs/core/factories/http";
import type { ApplicationService, LoggerService } from "@adonisjs/core/types";
import { createServer } from "node:http";
import supertest from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApitallyProvider from "../../src/adonisjs/provider.js";
import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub, setupOtel, teardownOtel } from "../utils.js";
import { createApp, createRoutes } from "./app.js";

describe("Middleware for AdonisJS", () => {
  let app: ApplicationService;
  let provider: ApitallyProvider;
  let client: ApitallyClient;
  let testAgent: supertest.Agent;

  beforeEach(async () => {
    mockApitallyHub();

    app = createApp();
    await app.init();
    await app.boot();

    app.container.singleton("logger", async () => {
      const { LoggerManager } = await import("@adonisjs/logger");
      const loggerConfig = {
        default: "app",
        loggers: {
          app: {
            enabled: true,
          },
        },
      };
      return new LoggerManager<any>(loggerConfig) as LoggerService;
    });

    provider = new ApitallyProvider(app);
    provider.register();
    await provider.start();

    const logger = await app.container.make("logger");
    const server = new ServerFactory().merge({ app, logger }).create();
    const router = server.getRouter();
    createRoutes(router);
    app.container.bindValue("router", router);
    await server.boot();

    client = await app.container.make("apitallyClient");
    setupOtel();

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
      {
        method: "GET",
        path: "/traces",
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
    expect(call[3]).toBeDefined();
    expect(call[3]).toHaveLength(1);
    expect(call[3]![0].message).toBe("Pino test");
    expect(call[3]![0].level).toBe("info");
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
    expect(call[3]).toBeDefined();
    expect(call[3]).toHaveLength(1);
    expect(call[3]![0].message).toBe("Console test");
    expect(call[3]![0].level).toBe("warn");
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

  it("Tracing", async () => {
    const spy = vi.spyOn(client.requestLogger, "logRequest");
    await testAgent.get("/traces").expect(200);
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0];
    const spans = call[4];
    expect(spans).toBeDefined();
    expect(spans).toHaveLength(4);

    const spanNames = new Set(spans!.map((s) => s.name));
    expect(spanNames).toContain("GET /traces");
    expect(spanNames).toContain("outer_span");
    expect(spanNames).toContain("inner_span_1");
    expect(spanNames).toContain("inner_span_2");

    const rootSpan = spans!.find((s) => s.name === "GET /traces");
    expect(rootSpan).toBeDefined();
    expect(rootSpan!.parentSpanId).toBeNull();

    const outerSpan = spans!.find((s) => s.name === "outer_span");
    expect(outerSpan).toBeDefined();
    expect(outerSpan!.parentSpanId).toBe(rootSpan!.spanId);

    const traceId = call[5];
    expect(traceId).toBeDefined();
    expect(typeof traceId).toBe("string");
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  afterEach(async () => {
    await provider.shutdown();
    teardownOtel();
  });
});
