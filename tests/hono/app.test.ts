import { Hono } from "hono";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub } from "../utils.js";
import { getApp, getNestedApp } from "./app.js";

describe("Middleware for Hono", () => {
  let app: Hono;
  let client: ApitallyClient;

  beforeEach(async () => {
    mockApitallyHub();
    app = await getApp();
    client = ApitallyClient.getInstance();

    // Wait for 600 ms for startup data to be set
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  it("Request counter", async () => {
    let res;
    res = await app.request("/hello?name=John&age=20");
    await res.text();
    expect(res.status).toBe(200);

    const body = JSON.stringify({ name: "John", age: 20 });
    res = await app.request("/hello", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length.toString(),
      },
    });
    let resText = await res.text();
    expect(res.status).toBe(200);
    expect(resText).toBe("Hello John! You are 20 years old!");

    res = await app.request("/hello/123");
    await res.text();
    expect(res.status).toBe(200);

    res = await app.request("/hello?name=Bob&age=17");
    const resJson = await res.json();
    expect(res.status).toBe(400); // invalid (age < 18)
    expect(resJson.success).toBe(false);
    expect(resJson.error.name).toBe("ZodError");

    res = await app.request("/hello?name=X&age=1");
    await res.text();
    expect(res.status).toBe(400); // invalid (name too short and age < 18)

    res = await app.request("/error");
    await res.text();
    expect(res.status).toBe(500);

    res = await app.request("/stream");
    expect(res.status).toBe(200);
    resText = await res.text();
    expect(resText).toBe("Hello\nworld");

    await setImmediate();

    const requests = client.requestCounter.getAndResetRequests();
    expect(requests.length).toBe(6);
    expect(
      requests.some(
        (r) =>
          r.consumer === "test" &&
          r.method === "GET" &&
          r.path === "/hello" &&
          r.status_code === 200 &&
          r.request_size_sum === 0 &&
          r.response_size_sum > 0,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/hello/:id" &&
          r.status_code === 200,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "POST" &&
          r.path === "/hello" &&
          r.status_code === 200 &&
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
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/stream" &&
          r.status_code === 200 &&
          r.request_size_sum === 0 &&
          r.response_size_sum === 11,
      ),
    ).toBe(true);
  });

  it("Request logger", async () => {
    const spy = vi.spyOn(client.requestLogger, "logRequest");
    let call;
    let res;

    res = await app.request("/hello?name=John&age=20");
    await res.text();
    expect(res.status).toBe(200);

    await setImmediate();

    expect(spy).toHaveBeenCalledOnce();
    call = spy.mock.calls[0];
    expect(call[0].method).toBe("GET");
    expect(call[0].path).toBe("/hello");
    expect(call[0].url).toBe("http://localhost/hello?name=John&age=20");
    expect(call[0].consumer).toBe("test");
    expect(call[1].statusCode).toBe(200);
    expect(call[1].responseTime).toBeGreaterThan(0);
    expect(call[1].responseTime).toBeLessThan(1);
    expect(call[1].size).toBeGreaterThan(0);
    expect(call[1].headers).toContainEqual([
      "content-type",
      "text/plain;charset=UTF-8",
    ]);
    expect(call[1].body).toBeInstanceOf(Buffer);
    expect(call[1].body!.toString()).toMatch(/^Hello John!/);
    expect(call[3]).toBeDefined();
    expect(call[3]).toHaveLength(1);
    expect(call[3]![0].level).toBe("warn");
    expect(call[3]![0].message).toBe("Console test");
    spy.mockReset();

    const body = JSON.stringify({ name: "John", age: 20 });
    res = await app.request("/hello", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length.toString(),
      },
    });
    await res.text();
    expect(res.status).toBe(200);

    await setImmediate();

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
    let res = await app.request("/hello?name=Bob&age=20");
    await res.text();
    expect(res.status).toBe(200);

    res = await app.request("/hello?name=Bob&age=17");
    await res.text();
    expect(res.status).toBe(400);

    res = await app.request("/hello?name=X&age=1");
    await res.text();
    expect(res.status).toBe(400);

    await setImmediate();

    const validationErrors =
      client.validationErrorCounter.getAndResetValidationErrors();
    expect(validationErrors.length).toBe(2);
    expect(validationErrors.find((e) => e.loc[0] == "age")?.error_count).toBe(
      2,
    );
    expect(validationErrors.find((e) => e.loc[0] == "name")?.error_count).toBe(
      1,
    );
  });

  it("Server error counter", async () => {
    const res = await app.request("/error");
    await res.text();
    expect(res.status).toBe(500);

    await setImmediate();

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
        path: "/stream",
      },
    ]);
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});

describe("Middleware for Hono with nested app", () => {
  let app: Hono;
  let client: ApitallyClient;

  beforeEach(async () => {
    mockApitallyHub();
    app = await getNestedApp();
    client = ApitallyClient.getInstance();

    // Wait for 600 ms for startup data to be set
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  it("Request counter", async () => {
    const res = await app.request("/api/v1/hello");
    await res.text();
    expect(res.status).toBe(200);

    await setImmediate();

    const requests = client.requestCounter.getAndResetRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "GET", path: "/api/v1/hello" });
  });

  it("List endpoints", async () => {
    expect(client.startupData?.paths).toEqual([
      {
        method: "GET",
        path: "/api/v1/hello",
      },
    ]);
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});
