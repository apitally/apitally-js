import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { getAppInfo } from "../../src/hapi/utils.js";
import { mockApitallyHub, setupOtel, teardownOtel } from "../utils.js";
import { getApp } from "./app.js";

describe("Plugin for Hapi", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let client: ApitallyClient;

  beforeEach(async () => {
    mockApitallyHub();
    app = await getApp();
    client = ApitallyClient.getInstance();
    setupOtel();
  });

  it("Request counter", async () => {
    let response = await app.inject({
      method: "GET",
      url: "/hello?name=John&age=20",
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.stringify({ name: "John", age: 20 });
    response = await app.inject({
      method: "POST",
      url: "/hello",
      payload: body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length.toString(),
      },
    });
    expect(response.statusCode).toBe(200);

    response = await app.inject({
      method: "GET",
      url: "/hello/123",
    });
    expect(response.statusCode).toBe(200);

    // invalid (age < 18)
    response = await app.inject({
      method: "GET",
      url: "/hello?name=Bob&age=17",
    });
    expect(response.statusCode).toBe(400);

    // invalid (name too short and age < 18)
    response = await app.inject({
      method: "GET",
      url: "/hello?name=X&age=1",
    });
    expect(response.statusCode).toBe(400);

    response = await app.inject({
      method: "GET",
      url: "/error",
    });
    expect(response.statusCode).toBe(500);

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
          r.path === "/hello/{id}" &&
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
          r.status_code === 400 &&
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

    await app.inject({
      method: "GET",
      url: "/hello?name=John&age=20",
    });

    expect(spy).toHaveBeenCalledOnce();
    call = spy.mock.calls[0];
    expect(call[0].method).toBe("get");
    expect(call[0].path).toBe("/hello");
    expect(call[0].url).toBe("http://localhost:3000/hello?name=John&age=20");
    expect(call[0].consumer).toBe("test");
    expect(call[1].statusCode).toBe(200);
    expect(call[1].responseTime).toBeGreaterThan(0);
    expect(call[1].responseTime).toBeLessThan(1);
    expect(call[1].size).toBeGreaterThan(0);
    expect(call[1].headers).toContainEqual([
      "content-type",
      "text/html; charset=utf-8",
    ]);
    expect(call[1].body).toBeInstanceOf(Buffer);
    expect(call[1].body!.toString()).toMatch(/^Hello John!/);
    expect(call[3]).toBeDefined();
    expect(call[3]).toHaveLength(2);
    expect(call[3]![0].level).toBe("warn");
    expect(call[3]![0].message).toBe("Console test");
    expect(call[3]![1].level).toBe("info");
    expect(call[3]![1].message).toBe("Hapi test");
    spy.mockReset();

    const body = JSON.stringify({ name: "John", age: 20 });
    await app.inject({
      method: "POST",
      url: "/hello",
      payload: body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length.toString(),
      },
    });

    expect(spy).toHaveBeenCalledOnce();
    call = spy.mock.calls[0];
    expect(call[0].method).toBe("post");
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

  it("Server error counter", async () => {
    await app.inject({
      method: "GET",
      url: "/error",
    });

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

    const response = await app.inject({
      method: "GET",
      url: "/traces",
    });
    expect(response.statusCode).toBe(200);

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

  it("List endpoints", async () => {
    const appInfo = getAppInfo(app);
    client.setStartupData(appInfo);

    expect(client.startupData?.paths).toEqual([
      {
        method: "GET",
        path: "/error",
      },
      {
        method: "GET",
        path: "/hello",
      },
      {
        method: "GET",
        path: "/traces",
      },
      {
        method: "GET",
        path: "/hello/{id}",
      },
      {
        method: "POST",
        path: "/hello",
      },
    ]);
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
    teardownOtel();
  });
});
