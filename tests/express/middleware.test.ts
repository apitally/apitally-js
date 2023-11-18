import { Express } from "express";
import request from "supertest";

import { ApitallyClient } from "../../src/common/client";
import { API_KEY, mockApitallyHub } from "../mocks/hub";
import { getAppWithCelebrate, getAppWithValidator } from "./apps";

describe("Middleware for Express with celebrate", () => {
  let app: Express;
  let appTest: request.SuperTest<request.Test>;
  let client: ApitallyClient;
  const authHeader = { Authorization: `ApiKey ${API_KEY}` };

  beforeEach(async () => {
    mockApitallyHub();
    app = getAppWithCelebrate();
    appTest = request(app);
    client = ApitallyClient.getInstance();

    // Wait for 0.1 seconds for app info to be set
    await new Promise((resolve) => setTimeout(resolve, 110));
  });

  it("Request and validation error logger", async () => {
    await appTest.get("/hello?name=John&age=20").set(authHeader).expect(200); // valid
    await appTest.get("/hello?name=Bob&age=17").set(authHeader).expect(400); // invalid (age < 18)
    await appTest.get("/hello?name=X&age=1").set(authHeader).expect(400); // invalid (name too short and age < 18)

    const requests = client.requestLogger.getAndResetRequests();
    expect(requests.length).toBe(2);
    expect(
      requests.some((r) => r.status_code === 400 && r.request_count === 2),
    ).toBe(true);
    expect(requests.every((r) => r.consumer == "key:1")).toBe(true);

    const validationErrors =
      client.validationErrorLogger.getAndResetValidationErrors();
    expect(validationErrors.length).toBe(2);
    expect(
      validationErrors.find((e) => e.loc[0] == "query" && e.loc[1] == "age")
        ?.error_count,
    ).toBe(2);
    expect(validationErrors.every((e) => e.consumer == "key:1")).toBe(true);
  });

  it("Authentication and permission checks", async () => {
    await appTest.get("/hello?name=John&age=20").set(authHeader).expect(200);
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

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});

describe("Middleware for Express with express-validator and custom API key header", () => {
  let app: Express;
  let appTest: request.SuperTest<request.Test>;
  let client: ApitallyClient;
  const authHeader = { ApiKey: API_KEY };

  beforeEach(async () => {
    mockApitallyHub();
    app = getAppWithValidator();
    appTest = request(app);
    client = ApitallyClient.getInstance();

    // Wait for 0.1 seconds for app info to be set
    await new Promise((resolve) => setTimeout(resolve, 110));
  });

  it("Validation error logger", async () => {
    await appTest.get("/hello?name=John&age=20").set(authHeader).expect(200); // valid
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

  it("Authentication and permission checks", async () => {
    await appTest.get("/hello?name=John&age=20").set(authHeader).expect(200);
    await appTest
      .get("/hello?name=John&age=20")
      .set({ ApiKey: "xxx" })
      .expect(403);
    await appTest.get("/hello?name=John&age=20").expect(403);
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});
