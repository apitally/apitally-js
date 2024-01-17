import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { FastifyInstance } from "fastify";
import request from "supertest";

import { ApitallyClient } from "../../src/common/client.js";
import { API_KEY, mockApitallyHub } from "../utils.js";
import { getApp } from "./app.js";

jest.mock("../../src/common/packageVersions.ts");

const testCases = [
  {
    name: "Plugin for Fastify",
  },
  {
    name: "Plugin for Fastify with custom API key header",
    customHeader: "ApiKey",
  },
];

testCases.forEach(({ name, customHeader }) => {
  describe(name, () => {
    let app: FastifyInstance;
    let appTest: request.SuperTest<request.Test>;
    let client: ApitallyClient;
    const authHeader = customHeader
      ? { [customHeader]: API_KEY }
      : { Authorization: `ApiKey ${API_KEY}` };

    beforeEach(async () => {
      mockApitallyHub();
      app = await getApp(customHeader);
      app.printRoutes;
      appTest = request(app.server);
      client = ApitallyClient.getInstance();
      await app.ready();

      // Wait for 0.2 seconds for app info to be set
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    if (!customHeader) {
      it("Request logger", async () => {
        await appTest
          .get("/hello?name=John&age=20")
          .set(authHeader)
          .expect(200);
        await appTest.get("/hello?name=Bob&age=17").set(authHeader).expect(400); // invalid (age < 18)
        await appTest.get("/hello?name=X&age=1").set(authHeader).expect(400); // invalid (name too short and age < 18)
        await appTest.get("/error").set(authHeader).expect(500);

        const requests = client.requestLogger.getAndResetRequests();
        expect(requests.length).toBe(3);
        expect(
          requests.some(
            (r) =>
              r.method === "GET" &&
              r.path === "/hello" &&
              r.status_code === 200,
          ),
        ).toBe(true);
        expect(
          requests.some((r) => r.status_code === 400 && r.request_count === 2),
        ).toBe(true);
        expect(
          requests.some((r) => r.status_code === 500 && r.request_count === 1),
        ).toBe(true);
        expect(requests.every((r) => r.consumer == "key:1")).toBe(true);
      });

      it("Validation error logger", async () => {
        await appTest
          .get("/hello?name=John&age=20")
          .set(authHeader)
          .expect(200);
        await appTest.get("/hello?name=Bob&age=17").set(authHeader).expect(400); // invalid (age < 18)
        await appTest.get("/hello?name=X&age=1").set(authHeader).expect(400); // invalid (name too short and age < 18)

        const validationErrors =
          client.validationErrorLogger.getAndResetValidationErrors();
        expect(validationErrors.length).toBe(2);
        expect(
          validationErrors.find((e) => e.loc[0] == "query" && e.loc[1] == "age")
            ?.error_count,
        ).toBe(2);
        expect(validationErrors.every((e) => e.consumer == "key:1")).toBe(true);
      });

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
        await appTest
          .get("/hello?name=John&age=20")
          .set({ ApiKey: API_KEY })
          .expect(401);
        await appTest.get("/hello/1").set(authHeader).expect(403);
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
