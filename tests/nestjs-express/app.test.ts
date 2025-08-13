import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub } from "../utils.js";
import { getApp } from "./app.js";

describe("Middleware for NestJS (Express)", () => {
  let app: INestApplication;
  let appTest: request.Agent;
  let client: ApitallyClient;

  beforeEach(async () => {
    mockApitallyHub();
    app = await getApp();
    appTest = request(app.getHttpServer());
    client = ApitallyClient.getInstance();

    // Wait for 1.2 seconds for startup data to be set
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });

  it("Request counter", async () => {
    await appTest.get("/hello?name=John&age=20").expect(200);
    await appTest.post("/hello").send({ name: "John", age: 20 }).expect(201);
    await appTest.get("/hello?name=Bob&age=17").expect(400); // invalid (age < 18)
    await appTest.get("/hello?name=X&age=1").expect(400); // invalid (name too short and age < 18)

    await appTest.get("/error").expect(500);

    const requests = client.requestCounter.getAndResetRequests();
    expect(requests.length).toBe(4);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/hello" &&
          r.status_code === 200 &&
          r.consumer === "test" &&
          r.response_size_sum > 0,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "POST" &&
          r.path === "/hello" &&
          r.status_code === 201 &&
          r.consumer === "test" &&
          r.request_size_sum > 0 &&
          r.response_size_sum > 0,
      ),
    ).toBe(true);
    expect(
      requests.some((r) => r.status_code === 400 && r.request_count === 2),
    ).toBe(true);
    expect(
      requests.some((r) => r.status_code === 500 && r.request_count === 1),
    ).toBe(true);
  });

  it("Request logger", async () => {
    const spy = vi.spyOn(client.requestLogger, "logRequest");
    let call;

    await appTest.get("/hello?name=John&age=20").expect(200);
    expect(spy).toHaveBeenCalledOnce();
    call = spy.mock.calls[0];
    expect(call[0].method).toBe("GET");
    expect(call[0].path).toBe("/hello");
    expect(call[0].url).toMatch(
      /^http:\/\/127\.0\.0\.1(:\d+)?\/hello\?name=John&age=20$/,
    );
    expect(call[0].consumer).toBe("test");
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
    expect(call[3]![0].logger).toBe("AppController");
    expect(call[3]![0].level).toBe("log");
    expect(call[3]![0].message).toBe("Logger test");
    spy.mockReset();

    await appTest.post("/hello").send({ name: "John", age: 20 }).expect(201);
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
    await appTest.get("/hello?name=John&age=20").expect(200);
    await appTest.get("/hello?name=Bob&age=17").expect(400); // invalid (age < 18)
    await appTest.get("/hello?name=X&age=1").expect(400); // invalid (name too short and age < 18)

    const validationErrors =
      client.validationErrorCounter.getAndResetValidationErrors();
    expect(validationErrors.length).toBe(2);
    expect(
      validationErrors.find((e) => e.msg.startsWith("age"))?.error_count,
    ).toBe(2);
  });

  it("Server error counter", async () => {
    await appTest.get("/error").expect(500);

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

  it("List endpoints", async () => {
    expect(client.startupData?.paths).toEqual([
      {
        method: "GET",
        path: "/hello",
      },
      {
        method: "POST",
        path: "/hello",
      },
      {
        method: "GET",
        path: "/hello/:id",
      },
      {
        method: "GET",
        path: "/error",
      },
    ]);
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});
