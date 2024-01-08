import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import nock from "nock";

import { ApitallyClient } from "../../src/common/client.js";
import { APITALLY_HUB_BASE_URL, CLIENT_ID, ENV } from "../utils.js";

describe("Client", () => {
  beforeAll(() => {
    nock(APITALLY_HUB_BASE_URL)
      .persist()
      .post(/\/requests$/)
      .reply(202);
  });

  it("Argument validation on instantiation", () => {
    expect(() => new ApitallyClient({ clientId: "xxx" })).toThrow("xxx");
    expect(
      () => new ApitallyClient({ clientId: CLIENT_ID, env: "..." }),
    ).toThrow("...");
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
      .post(/\/(info|requests)$/)
      .reply(404, `Client ID '${CLIENT_ID}' not found`);

    const client = new ApitallyClient({
      clientId: CLIENT_ID,
      env: ENV,
    });
    jest.spyOn(client.logger, "error").mockImplementation(() => {});
    client.setAppInfo({ paths: [], versions: new Map(), client: "js:test" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client["syncIntervalId"]).toBeUndefined();
  });

  it("Exit if initial API key sync fails", async () => {
    nock(APITALLY_HUB_BASE_URL)
      .persist()
      .post(/\/info$/)
      .reply(202);
    nock(APITALLY_HUB_BASE_URL)
      .persist()
      .get(/\/keys$/)
      .reply(400);

    const client = new ApitallyClient({
      clientId: CLIENT_ID,
      env: ENV,
      syncApiKeys: true,
    });
    jest.spyOn(client.logger, "error").mockImplementation(() => {});
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  afterEach(async () => {
    await ApitallyClient.shutdown();
  });
});
