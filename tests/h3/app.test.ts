import { context, trace } from "@opentelemetry/api";
import type { H3 } from "h3";
import { setImmediate } from "node:timers/promises";
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
    res = await app.request("/v1/hello?name=John&age=20", { method: "GET" });
    await res.text();
    expect(res.status).toBe(200);

    const body = JSON.stringify({ name: "John", age: 20 });
    res = await app.request("/v1/hello", {
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

    res = await app.request("/v1/hello/123", { method: "GET" });
    await res.text();
    expect(res.status).toBe(200);

    res = await app.request("/v1/hello?name=Bob&age=17", { method: "GET" });
    const resJson = await res.json();
    expect(res.status).toBe(400); // invalid (age < 18)
    expect(resJson.statusText).toBe("Validation failed");
    expect(resJson.data.issues).toBeInstanceOf(Array);

    res = await app.request("/v1/hello?name=X&age=1", { method: "GET" });
    await res.text();
    expect(res.status).toBe(400); // invalid (name too short and age < 18)

    res = await app.request("/v2/error", { method: "GET" });
    await res.text();
    expect(res.status).toBe(500);

    await setImmediate();

    const requests = client.requestCounter.getAndResetRequests();
    expect(requests.length).toBe(5);
    expect(
      requests.some(
        (r) =>
          r.consumer === "test" &&
          r.method === "GET" &&
          r.path === "/v1/hello" &&
          r.status_code === 200 &&
          r.request_size_sum === 0 &&
          r.response_size_sum > 0,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/v1/hello/:id" &&
          r.status_code === 200,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "POST" &&
          r.path === "/v1/hello" &&
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

    res = await app.request("/v1/hello?name=John&age=20", { method: "GET" });
    await res.text();
    expect(res.status).toBe(200);

    await setImmediate();

    expect(spy).toHaveBeenCalledOnce();
    call = spy.mock.calls[0];
    expect(call[0].method).toBe("GET");
    expect(call[0].path).toBe("/v1/hello");
    expect(call[0].url).toBe("http://localhost/v1/hello?name=John&age=20");
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
    expect(call[3]![0].level).toBe("log");
    expect(call[3]![0].message).toBe("Console test");
    spy.mockReset();

    const body = JSON.stringify({ name: "John", age: 20 });
    res = await app.request("/v1/hello", {
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
    expect(call[0].path).toBe("/v1/hello");
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
    await app.request("/v1/hello?name=Bob&age=20", { method: "GET" });
    await app.request("/v1/hello?name=Bob&age=17", { method: "GET" });
    await app.request("/v1/hello?name=X&age=1", { method: "GET" });

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
    const res = await app.request("/v2/error", { method: "GET" });
    expect(res.status).toBe(500);

    const serverErrors = client.serverErrorCounter.getAndResetServerErrors();
    expect(serverErrors.length).toBe(1);
    expect(
      serverErrors.some(
        (e) =>
          e.type === "Error" &&
          e.msg === "test" &&
          e.traceback.startsWith("Error: test") &&
          e.error_count === 1,
      ),
    ).toBe(true);
  });

  it("Tracing", async () => {
    const spy = vi.spyOn(client.requestLogger, "logRequest");

    const res = await app.request("/v2/traces", { method: "GET" });
    await res.text();
    expect(res.status).toBe(200);

    await setImmediate();

    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0];
    const spans = call[4];
    expect(spans).toBeDefined();
    expect(spans).toHaveLength(4);

    const spanNames = new Set(spans!.map((s) => s.name));
    expect(spanNames).toContain("GET /v2/traces");
    expect(spanNames).toContain("outer_span");
    expect(spanNames).toContain("inner_span_1");
    expect(spanNames).toContain("inner_span_2");

    const rootSpan = spans!.find((s) => s.name === "GET /v2/traces");
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
    expect(client.startupData?.paths).toEqual([
      {
        method: "GET",
        path: "/v1/hello",
      },
      {
        method: "GET",
        path: "/v1/hello/:id",
      },
      {
        method: "POST",
        path: "/v1/hello",
      },
      {
        method: "GET",
        path: "/v2/error",
      },
      {
        method: "GET",
        path: "/v2/traces",
      },
    ]);
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
    context.disable();
    trace.disable();
  });
});
