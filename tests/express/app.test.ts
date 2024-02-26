import { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { mockApitallyHub } from "../utils.js";
import { getAppWithCelebrate, getAppWithValidator } from "./app.js";

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
    let appTest: request.SuperTest<request.Test>;
    let client: ApitallyClient;

    beforeEach(async () => {
      mockApitallyHub();
      app = getApp();
      appTest = request(app);
      client = ApitallyClient.getInstance();

      // Wait for 0.2 seconds for app info to be set
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    it("Request logger", async () => {
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
            r.method === "GET" &&
            r.path === "/hello" &&
            r.status_code === 200 &&
            r.request_size_sum == 0 &&
            r.response_size_sum > 0,
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

    it("Validation error logger", async () => {
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

    it("List endpoints", async () => {
      expect(client.appInfo?.paths).toEqual([
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
          path: "/hello/:id(\\d+)",
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
});
