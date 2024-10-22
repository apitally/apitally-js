import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub } from "../utils.js";
import { getApp } from "./app.js";

describe("Middleware for Hono", () => {
  let app: Hono;
  let client: ApitallyClient;

  beforeEach(async () => {
    mockApitallyHub();
    app = await getApp();
    client = ApitallyClient.getInstance();

    // Wait for 1.2 seconds for startup data to be set
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });

  it("Request logger", async () => {
    let res;
    res = await app.request("/hello?name=John&age=20");
    expect(res.status).toBe(200);

    const body = JSON.stringify({ name: "John", age: 20 });
    res = await app.request("/hello", {
      method: "POST",
      body: body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length.toString(),
      },
    });
    expect(res.status).toBe(200);

    // res = await app.request("/hello?name=Bob&age=17");
    // expect(res.status).toBe(400); // invalid (age < 18)

    // res = await app.request("/hello?name=X&age=1");
    // expect(res.status).toBe(400); // invalid (name too short and age < 18)

    res = await app.request("/error");
    expect(res.status).toBe(500);

    const requests = client.requestCounter.getAndResetRequests();
    const serverErrors = client.serverErrorCounter.getAndResetServerErrors();
    expect(requests.length).toBe(3);
    expect(
      requests.some(
        (r) =>
          r.consumer === "test" &&
          r.method === "GET" &&
          r.path === "/hello" &&
          r.status_code === 200 &&
          r.consumer === "test",
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "POST" &&
          r.path === "/hello" &&
          r.status_code === 200 &&
          r.request_size_sum > 0,
      ),
    ).toBe(true);
    expect(
      requests.some((r) => r.status_code === 500 && r.request_count === 1),
    ).toBe(true);
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
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});
