import nock from "nock";

export const APITALLY_HUB_BASE_URL = "https://hub.apitally.io";
export const CLIENT_ID = "fa4f144d-33be-4694-95e4-f5c18b0f151d";
export const ENV = "dev";

export const mockApitallyHub = () => {
  nock(APITALLY_HUB_BASE_URL)
    .persist()
    .post(/\/(info|requests)$/)
    .reply(202);
};
