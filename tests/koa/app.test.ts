import http from "http";
import Koa from "koa";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub } from "../utils.js";
import { getAppWithKoaRoute, getAppWithKoaRouter } from "./app.js";

const testCases = [
  {
    name: "Middleware for Koa with koa-router",
    router: "koa-router",
    getApp: getAppWithKoaRouter,
  },
  {
    name: "Middleware for Koa with koa-route",
    router: "koa-route",
    getApp: getAppWithKoaRoute,
  },
];

testCases.forEach(({ name, router, getApp }) => {
  describe(name, () => {
    let app: Koa;
    let appTest: request.Agent;
    let client: ApitallyClient;

    beforeEach(async () => {
      mockApitallyHub();
      app = getApp();
      const server = http.createServer(app.callback());
      appTest = request(server);
      client = ApitallyClient.getInstance();

      // Wait for 600 ms for startup data to be set
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    it("Request counter", async () => {
      await appTest.get("/hello?name=John&age=20").expect(200);
      await appTest.post("/hello").send({ name: "John", age: 20 }).expect(200);

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      await appTest.get("/error").expect(500);
      consoleSpy.mockRestore();

      const requests = client.requestCounter.getAndResetRequests();
      expect(requests.length).toBe(3);
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
      expect(requests.some((r) => r.status_code === 500)).toBe(true);
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
        /^http:\/\/127\.0\.0\.1:\d+\/hello\?name=John&age=20$/,
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

    it("Server error counter", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      await appTest.get("/error").expect(500);
      consoleSpy.mockRestore();

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

    if (router === "koa-router") {
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
    }

    afterEach(async () => {
      if (client) {
        await client.handleShutdown();
      }
    });
  });
});
