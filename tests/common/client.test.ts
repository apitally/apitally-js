import nock from "nock";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ApitallyClient } from "../../src/common/client.js";
import { APITALLY_HUB_BASE_URL, CLIENT_ID, ENV } from "../utils.js";

describe("Client", () => {
  beforeAll(() => {
    nock(APITALLY_HUB_BASE_URL)
      .persist()
      .post(/\/sync$/)
      .reply(202);
  });

  it("Client ID validation on instantiation", () => {
    const client = new ApitallyClient({ clientId: "xxx" });
    expect(client.isEnabled()).toBe(false);
  });

  it("Env validation on instantiation", () => {
    const client = new ApitallyClient({ clientId: CLIENT_ID, env: "..." });
    expect(client.isEnabled()).toBe(false);
  });

  it("Singleton instantiation", () => {
    expect(() => ApitallyClient.getInstance()).toThrow("not initialized");
    expect(() => {
      new ApitallyClient({ clientId: CLIENT_ID, env: ENV });
      new ApitallyClient({ clientId: CLIENT_ID, env: "other" });
    }).toThrow("already initialized");
  });

  it("Stop sync if client ID is invalid", async () => {
    nock(APITALLY_HUB_BASE_URL)
      .persist()
      .post(/\/(startup|sync)$/)
      .reply(404, `Client ID '${CLIENT_ID}' not found`);

    const client = new ApitallyClient({
      clientId: CLIENT_ID,
      env: ENV,
    });
    vi.spyOn(client.logger, "error").mockImplementation(() => {});
    client.setStartupData({ paths: [], versions: {}, client: "js:test" });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client["syncIntervalId"]).toBeUndefined();
  });

  afterEach(async () => {
    await ApitallyClient.shutdown();
  });
});
