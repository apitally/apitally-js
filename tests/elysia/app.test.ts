import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { getAppInfo } from "../../src/elysia/utils.js";
import { mockApitallyHub } from "../utils.js";
import { getApp } from "./app.js";

describe("Plugin for Elysia", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let client: ApitallyClient;

  beforeEach(async () => {
    mockApitallyHub();
    app = getApp();
    client = ApitallyClient.getInstance();
  });

  it("Request counter", async () => {
    let response: Response;

    response = await app.handle(
      new Request("http://localhost/hello?name=John&age=20"),
    );
    expect(response.status).toBe(200);

    const body = JSON.stringify({ name: "John", age: 20 });
    response = await app.handle(
      new Request("http://localhost/hello", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length.toString(),
        },
      }),
    );
    expect(response.status).toBe(200);

    response = await app.handle(new Request("http://localhost/hello/123"));
    expect(response.status).toBe(200);

    // invalid (age < 18)
    response = await app.handle(
      new Request("http://localhost/hello?name=Bob&age=17"),
    );
    expect(response.status).toBeOneOf([400, 422]);

    // invalid (name too short and age < 18)
    response = await app.handle(
      new Request("http://localhost/hello?name=X&age=1"),
    );
    expect(response.status).toBeOneOf([400, 422]);

    response = await app.handle(new Request("http://localhost/error"));
    expect(response.status).toBe(500);

    await setImmediate(); // Wait for onAfterResponse to be called

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
      requests.some(
        (r) =>
          (r.status_code === 400 || r.status_code === 422) &&
          r.response_size_sum > 0 &&
          r.request_count === 2,
      ),
    ).toBe(true);
    expect(
      requests.some((r) => r.status_code === 500 && r.request_count === 1),
    ).toBe(true);
  });

  it("Request logger", async () => {
    const spy = vi.spyOn(client.requestLogger, "logRequest");
    let call;

    await app.handle(new Request("http://localhost/hello?name=John&age=20"));
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
    expect(call[1].headers).toContainEqual(["content-type", "text/plain"]);
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
    await app.handle(new Request("http://localhost/hello?name=John&age=20"));
    await app.handle(new Request("http://localhost/hello?name=Bob&age=17"));
    await app.handle(new Request("http://localhost/hello?name=X&age=1"));
    await setImmediate();

    const validationErrors =
      client.validationErrorCounter.getAndResetValidationErrors();
    expect(validationErrors.length).toBe(2);
  });

  it("Server error counter", async () => {
    await app.handle(new Request("http://localhost/error"));
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
    // @ts-expect-error app has complex type
    const appInfo = getAppInfo(app);
    client.setStartupData(appInfo);

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
