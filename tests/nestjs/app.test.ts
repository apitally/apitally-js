import { INestApplication } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub } from "../utils.js";
import { getApp } from "./app.js";

describe("Middleware for NestJS", () => {
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

  it("Request logger", async () => {
    await appTest.get("/hello?name=John&age=20").expect(200);
    await appTest.get("/hello?name=Bob&age=17").expect(400); // invalid (age < 18)
    await appTest.get("/hello?name=X&age=1").expect(400); // invalid (name too short and age < 18)

    const loggerSpy = vi
      .spyOn((BaseExceptionFilter as any).logger, "error")
      .mockImplementation(() => {});
    await appTest.get("/error").expect(500);
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

  it("Validation error logger", async () => {
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

  it("List endpoints", async () => {
    expect(client.startupData?.paths).toEqual([
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

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});
