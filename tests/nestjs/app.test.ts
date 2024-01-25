import { INestApplication } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { ApitallyApiKeyGuard } from "../../src/nestjs/auth.js";
import { API_KEY, mockApitallyHub } from "../utils.js";
import { getApp } from "./app.js";

describe("Middleware for NestJS", () => {
  let app: INestApplication;
  let appTest: request.SuperTest<request.Test>;
  let client: ApitallyClient;
  const authHeader = { Authorization: `ApiKey ${API_KEY}` };

  beforeEach(async () => {
    mockApitallyHub();
    app = await getApp();
    appTest = request(app.getHttpServer());
    client = ApitallyClient.getInstance();
    ApitallyApiKeyGuard.customHeader = undefined;

    // Wait for 0.2 seconds for app info to be set
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it("Request logger", async () => {
    await appTest.get("/hello?name=John&age=20").set(authHeader).expect(200);
    await appTest.get("/hello?name=Bob&age=17").set(authHeader).expect(400); // invalid (age < 18)
    await appTest.get("/hello?name=X&age=1").set(authHeader).expect(400); // invalid (name too short and age < 18)

    const loggerSpy = vi
      .spyOn((BaseExceptionFilter as any).logger, "error")
      .mockImplementation(() => {});
    await appTest.get("/error").set(authHeader).expect(500);
    loggerSpy.mockRestore();

    const requests = client.requestCounter.getAndResetRequests();
    expect(requests.length).toBe(3);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/hello" &&
          r.status_code === 200 &&
          r.response_size_sum > 0,
      ),
    ).toBe(true);
    expect(
      requests.some((r) => r.status_code === 400 && r.request_count === 2),
    ).toBe(true);
    expect(
      requests.some((r) => r.status_code === 500 && r.request_count === 1),
    ).toBe(true);
    expect(requests.every((r) => r.consumer == "key:1")).toBe(true);
  });

  it("Validation error logger", async () => {
    await appTest.get("/hello?name=John&age=20").set(authHeader).expect(200);
    await appTest.get("/hello?name=Bob&age=17").set(authHeader).expect(400); // invalid (age < 18)
    await appTest.get("/hello?name=X&age=1").set(authHeader).expect(400); // invalid (name too short and age < 18)

    const validationErrors =
      client.validationErrorCounter.getAndResetValidationErrors();
    expect(validationErrors.length).toBe(2);
    expect(
      validationErrors.find((e) => e.msg.startsWith("age"))?.error_count,
    ).toBe(2);
    expect(validationErrors.every((e) => e.consumer == "key:1")).toBe(true);
  });

  it("List endpoints", async () => {
    expect(client.appInfo?.paths).toEqual([
      {
        method: "GET",
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

  it("Authentication", async () => {
    await appTest.get("/hello?name=John&age=20").set(authHeader).expect(200);
    await appTest.get("/hello?name=John&age=20").expect(401);
    const res = await appTest
      .get("/hello?name=John&age=20")
      .set({ Authorization: `Bearer ${API_KEY}` })
      .expect(401);
    expect(res.headers["www-authenticate"]).toBe("ApiKey");
    await appTest
      .get("/hello?name=John&age=20")
      .set({ Authorization: `ApiKey xxx` })
      .expect(403);
    await appTest
      .get("/hello?name=John&age=20")
      .set({ ApiKey: API_KEY })
      .expect(401);
    await appTest.get("/hello/1").set(authHeader).expect(403);
  });

  it("Authentication with custom API key header", async () => {
    ApitallyApiKeyGuard.customHeader = "ApiKey";
    await appTest
      .get("/hello?name=John&age=20")
      .set({ ApiKey: API_KEY })
      .expect(200);
    await appTest
      .get("/hello?name=John&age=20")
      .set({ ApiKey: "xxx" })
      .expect(403);
    await appTest.get("/hello?name=John&age=20").expect(403);
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});
