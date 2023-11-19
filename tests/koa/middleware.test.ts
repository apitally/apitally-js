import http from "http";
import Koa from "koa";
import request from "supertest";

import { ApitallyClient } from "../../src/common/client";
import { API_KEY, mockApitallyHub } from "../mocks/hub";
import { getAppWithKoaRoute, getAppWithKoaRouter } from "./apps";

const testCases = [
  {
    name: "Middleware for Koa with koa-router",
    router: "koa-router",
    getApp: getAppWithKoaRouter,
  },
  {
    name: "Middleware for Koa with koa-route and custom API key header",
    router: "koa-route",
    getApp: getAppWithKoaRoute,
    customHeader: "ApiKey",
  },
];

testCases.forEach(({ name, router, getApp, customHeader }) => {
  describe(name, () => {
    let app: Koa;
    let appTest: request.SuperTest<request.Test>;
    let client: ApitallyClient;
    const authHeader = customHeader
      ? { [customHeader]: API_KEY }
      : { Authorization: `ApiKey ${API_KEY}` };

    beforeEach(async () => {
      mockApitallyHub();
      app = getApp();
      const server = http.createServer(app.callback());
      appTest = request(server);
      client = ApitallyClient.getInstance();

      // Wait for 0.1 seconds for app info to be set
      await new Promise((resolve) => setTimeout(resolve, 110));
    });

    it("Request logger", async () => {
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      await appTest.get("/hello?name=John&age=20").set(authHeader).expect(200);
      await appTest.get("/error").set(authHeader).expect(500);
      consoleSpy.mockRestore();

      const requests = client.requestLogger.getAndResetRequests();
      expect(requests.length).toBe(2);
      expect(
        requests.some(
          (r) =>
            r.method === "GET" && r.path === "/hello" && r.status_code === 200,
        ),
      ).toBe(true);
      expect(requests.some((r) => r.status_code === 500)).toBe(true);
      expect(requests.every((r) => r.consumer == "key:1")).toBe(true);
    });

    if (router === "koa-router") {
      it("List endpoints", async () => {
        expect(client.appInfo?.paths).toEqual([
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
    }

    if (!customHeader) {
      it("Authentication", async () => {
        await appTest
          .get("/hello?name=John&age=20")
          .set(authHeader)
          .expect(200);
        await appTest.get("/hello?name=John&age=20").expect(401);
        await appTest
          .get("/hello?name=John&age=20")
          .set({ Authorization: `Bearer ${API_KEY}` })
          .expect(401);
        await appTest
          .get("/hello?name=John&age=20")
          .set({ Authorization: `ApiKey xxx` })
          .expect(403);
        await appTest.get("/hello/1").set(authHeader).expect(403); // missing scope
      });
    } else {
      it("Authentication", async () => {
        await appTest
          .get("/hello?name=John&age=20")
          .set(authHeader)
          .expect(200);
        await appTest
          .get("/hello?name=John&age=20")
          .set({ [customHeader]: "xxx" })
          .expect(403);
        await appTest.get("/hello?name=John&age=20").expect(403);
      });
    }

    afterEach(async () => {
      if (client) {
        await client.handleShutdown();
      }
    });
  });
});
