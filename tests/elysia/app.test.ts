import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub } from "../utils.js";
import { getApp } from "./app.js";

describe("Plugin for Elysia", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let client: ApitallyClient;

  beforeEach(async () => {
    mockApitallyHub();
    app = await getApp();
    client = ApitallyClient.getInstance();

    // Wait for 0.6 seconds for startup data to be set
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  it("Request counter", async () => {
    await app.handle(new Request("http://localhost/hello?name=John&age=20"));
    const body = JSON.stringify({ name: "John", age: 20 });
    await app.handle(
      new Request("http://localhost/hello", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length.toString(),
        },
      }),
    );
    await app.handle(new Request("http://localhost/hello/123"));
    await app.handle(new Request("http://localhost/hello?name=Bob&age=17")); // invalid (age < 18)
    await app.handle(new Request("http://localhost/hello?name=X&age=1")); // invalid (name too short and age < 18)
    await app.handle(new Request("http://localhost/error"));

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

    await app.handle(new Request("http://localhost/hello?name=John&age=20"));
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
      "text/plain; charset=utf-8",
    ]);
    expect(call[1].body).toBeInstanceOf(Buffer);
    expect(call[1].body!.toString()).toMatch(/^Hello John!/);
    expect(call[3]).toBeDefined();
    expect(call[3]).toHaveLength(1);
    expect(call[3]![0].level).toBe("warn");
    expect(call[3]![0].message).toBe("Console test");
    spy.mockReset();

    const body = JSON.stringify({ name: "John", age: 20 });
    await app.handle(
      new Request("http://localhost/hello", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length.toString(),
        },
      }),
    );
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
    expect(call[3]![0].level).toBe("info");
    expect(call[3]![0].message).toBe("Test 3");
  });

  it("Validation error counter", async () => {
    await app.handle(new Request("http://localhost/hello?name=John&age=20"));
    await app.handle(new Request("http://localhost/hello?name=Bob&age=17"));
    await app.handle(new Request("http://localhost/hello?name=X&age=1"));

    const validationErrors =
      client.validationErrorCounter.getAndResetValidationErrors();
    expect(validationErrors.length).toBe(2);
    expect(
      validationErrors.find((e) => e.loc.includes("age"))?.error_count,
    ).toBe(2);
    expect(
      validationErrors.find((e) => e.loc.includes("name"))?.error_count,
    ).toBe(1);
  });

  it("Server error counter", async () => {
    await app.handle(new Request("http://localhost/error"));

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
    ]);
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});
