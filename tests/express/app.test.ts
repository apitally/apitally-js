import { context, trace } from "@opentelemetry/api";
import { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { getRouterInfo } from "../../src/express/utils.js";
import { mockApitallyHub } from "../utils.js";
import {
  getAppWithCelebrate,
  getAppWithMiddlewareOnRouter,
  getAppWithNestedRouters,
  getAppWithValidator,
} from "./app.js";

const testCases = [
  {
    name: "Middleware for Express with celebrate",
    getApp: getAppWithCelebrate,
  },
  {
    name: "Middleware for Express with express-validator",
    getApp: getAppWithValidator,
  },
];

testCases.forEach(({ name, getApp }) => {
  describe(name, () => {
    let app: Express;
    let appTest: request.Agent;
    let client: ApitallyClient;

    beforeEach(async () => {
      mockApitallyHub();
      app = getApp();
      appTest = request(app);
      client = ApitallyClient.getInstance();

      // Wait for 600 ms for startup data to be set
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    it("Request counter", async () => {
      await appTest.get("/hello?name=John&age=20").expect(200);
      await appTest.post("/hello").send({ name: "John", age: 20 }).expect(200);
      await appTest.get("/hello?name=Bob&age=17").expect(400); // invalid (age < 18)
      await appTest.get("/hello?name=X&age=1").expect(400); // invalid (name too short and age < 18)
      await appTest.get("/error").expect(500);

      const requests = client.requestCounter.getAndResetRequests();
      expect(requests.length).toBe(4);
      expect(
        requests.some(
          (r) =>
            r.consumer === "test" &&
            r.method === "GET" &&
            r.path === "/hello" &&
            r.status_code === 200 &&
            r.request_size_sum === 0 &&
            r.response_size_sum > 0 &&
            r.consumer === "test",
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
      expect(call[3]).toHaveLength(3);
      expect(call[3]![0].level).toBe("warn");
      expect(call[3]![0].message).toBe("Console test");
      expect(call[3]![1].level).toBe("info");
      expect(call[3]![1].message).toBe("Pino test");
      expect(call[3]![2].level).toBe("info");
      expect(call[3]![2].message).toBe("Winston test");

      spy.mockReset();

      await appTest.post("/hello").send({ name: "John", age: 20 }).expect(200);
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
        validationErrors.find((e) => e.loc[0] == "query" && e.loc[1] == "age")
          ?.error_count,
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
        {
          method: "GET",
          path: "/traces",
        },
      ]);
    });

    it("Tracing", async () => {
      const spy = vi.spyOn(client.requestLogger, "logRequest");

      await appTest.get("/traces").expect(200);

      expect(spy).toHaveBeenCalledOnce();
      const call = spy.mock.calls[0];
      const spans = call[4];
      expect(spans).toBeDefined();
      expect(spans).toHaveLength(4);

      const spanNames = new Set(spans!.map((s) => s.name));
      expect(spanNames.has("GET /traces")).toBe(true);
      expect(spanNames.has("outer_span")).toBe(true);
      expect(spanNames.has("inner_span_1")).toBe(true);
      expect(spanNames.has("inner_span_2")).toBe(true);

      const traceId = call[5];
      expect(traceId).toBeDefined();
      expect(typeof traceId).toBe("string");
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    afterEach(async () => {
      if (client) {
        await client.handleShutdown();
      }
      context.disable();
      trace.disable();
    });
  });
});

describe("Middleware for Express router", () => {
  let app: Express;
  let appTest: request.Agent;
  let client: ApitallyClient;

  beforeEach(async () => {
    mockApitallyHub();
    app = getAppWithMiddlewareOnRouter();
    appTest = request(app);
    client = ApitallyClient.getInstance();

    // Wait for 1.2 seconds for startup data to be set
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });

  it("Request counter", async () => {
    await appTest.get("/api/hello").expect(200);

    const requests = client.requestCounter.getAndResetRequests();
    expect(requests.length).toBe(1);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/api/hello" &&
          r.status_code === 200,
      ),
    ).toBe(true);
  });

  it("List endpoints", async () => {
    expect(client.startupData?.paths).toEqual([
      {
        method: "GET",
        path: "/api/hello",
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

describe("Middleware for Express with nested routers", () => {
  let app: Express;
  let appTest: request.Agent;
  let client: ApitallyClient;

  beforeEach(async () => {
    mockApitallyHub();
    app = getAppWithNestedRouters();
    appTest = request(app);
    client = ApitallyClient.getInstance();

    // Wait for 1.2 seconds for startup data to be set
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });

  it("Request counter", async () => {
    await appTest.get("/health").expect(200);
    await appTest.get("/api/v1/hello/bob").expect(200);
    await appTest.get("/api/v2/goodbye/world").expect(200);
    await appTest.get("/test").expect(200);

    const requests = client.requestCounter.getAndResetRequests();
    expect(requests.length).toBe(4);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" && r.path === "/health" && r.status_code === 200,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/api/:version/hello/:name" &&
          r.status_code === 200,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" &&
          r.path === "/api/:version/goodbye/world" &&
          r.status_code === 200,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.method === "GET" && r.path === "/test" && r.status_code === 200,
      ),
    ).toBe(true);
  });

  it("List endpoints", async ({ skip }) => {
    const routerInfo = getRouterInfo(app);
    if (routerInfo.version === "v5") {
      skip(
        "Endpoint listing for nested routers is not yet supported on Express v5",
      );
    }

    expect(client.startupData?.paths).toEqual([
      {
        method: "GET",
        path: "/health",
      },
      {
        method: "GET",
        path: "/api/:version/hello/:name",
      },
      {
        method: "GET",
        path: "/api/:version/goodbye/world",
      },
      {
        method: "GET",
        path: "/test",
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
