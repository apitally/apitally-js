import type { H3 } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub } from "../utils.js";
import { getApp } from "./app.js";

describe("Middleware for H3", () => {
  let app: H3;
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
    res = await app.fetch("/hello?name=John&age=20", { method: "GET" });
    expect(res.status).toBe(200);

    const body = JSON.stringify({ name: "John", age: 20 });
    res = await app.fetch("/hello", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length.toString(),
      },
    });
    const resText = await res.text();
    expect(res.status).toBe(200);
    expect(resText).toBe("Hello John! You are 20 years old!");

    res = await app.fetch("/hello/123", { method: "GET" });
    expect(res.status).toBe(200);

    res = await app.fetch("/hello?name=Bob&age=17", { method: "GET" });
    const resJson = await res.json();
    expect(res.status).toBe(400); // invalid (age < 18)
    expect(resJson.statusText).toBe("Validation failed");
    expect(resJson.data.name).toBe("ZodError");

    res = await app.fetch("/hello?name=X&age=1", { method: "GET" });
    expect(res.status).toBe(400); // invalid (name too short and age < 18)

    res = await app.fetch("/error", { method: "GET" });
    expect(res.status).toBe(500);

    const requests = client.requestCounter.getAndResetRequests();
    expect(requests.length).toBe(5);
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
  });

  it("Request logger", async () => {
    const spy = vi.spyOn(client.requestLogger, "logRequest");
    let call;
    let res;

    res = await app.fetch("/hello?name=John&age=20", { method: "GET" });
    expect(res.status).toBe(200);
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
    spy.mockReset();

    const body = JSON.stringify({ name: "John", age: 20 });
    res = await app.fetch("/hello", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length.toString(),
      },
    });
    expect(res.status).toBe(200);
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
    await app.fetch("/hello?name=Bob&age=20", { method: "GET" });
    await app.fetch("/hello?name=Bob&age=17", { method: "GET" });
    await app.fetch("/hello?name=X&age=1", { method: "GET" });

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
    const res = await app.fetch("/error", { method: "GET" });
    expect(res.status).toBe(500);

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
