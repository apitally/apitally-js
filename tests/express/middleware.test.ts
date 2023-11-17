import { Express } from "express";
import nock from "nock";
import request from "supertest";

import { ApitallyClient } from "../../src/common/client";
import { getAppWithCelebrate } from "./apps";

const APITALLY_HUB_BASE_URL = "https://hub.apitally.io";
const API_KEY = "7ll40FB.DuHxzQQuGQU4xgvYvTpmnii7K365j9VI";
const API_KEY_HASH =
  "bcf46e16814691991c8ed756a7ca3f9cef5644d4f55cd5aaaa5ab4ab4f809208";
const SALT = "54fd2b80dbfeb87d924affbc91b77c76";

describe("Express middleware tests with celebrate", () => {
  let app: Express;
  let appTest: request.SuperTest<request.Test>;
  let client: ApitallyClient;

  beforeEach(async () => {
    nock(APITALLY_HUB_BASE_URL)
      .persist()
      .post(/\/(info|requests)$/)
      .reply(202);
    nock(APITALLY_HUB_BASE_URL)
      .persist()
      .get(/\/keys$/)
      .reply(200, {
        salt: SALT,
        keys: {
          [API_KEY_HASH]: {
            key_id: 1,
            api_key_id: 1,
            name: "Test",
            scopes: ["hello1"],
          },
        },
      });

    app = getAppWithCelebrate();
    appTest = request(app);
    client = ApitallyClient.getInstance();

    // Wait for 0.1 seconds for app info to be set
    await new Promise((resolve) => setTimeout(resolve, 110));
  });

  it("Requests and validation errors logged correctly", async () => {
    const authHeader = { Authorization: `ApiKey ${API_KEY}` };
    await appTest.get("/hello?name=John&age=20").set(authHeader).expect(200); // valid
    await appTest.get("/hello?name=Bob&age=17").set(authHeader).expect(400); // invalid (age < 18)
    await appTest.get("/hello?name=X&age=1").set(authHeader).expect(400); // invalid (name too short and age < 18)

    const requests = client.requestLogger.getAndResetRequests();
    expect(requests.length).toBe(2);
    expect(
      requests.some((r) => r.status_code === 400 && r.request_count === 2)
    ).toBe(true);
    expect(requests.every((r) => r.consumer == "key:1")).toBe(true);

    const validationErrors =
      client.validationErrorLogger.getAndResetValidationErrors();
    expect(validationErrors.length).toBe(2);
    expect(
      validationErrors.find((e) => e.loc[0] == "query" && e.loc[1] == "age")
        ?.error_count
    ).toBe(2);
    expect(validationErrors.every((e) => e.consumer == "key:1")).toBe(true);
  });

  afterEach(async () => {
    if (client) {
      await client.handleShutdown();
    }
  });
});
