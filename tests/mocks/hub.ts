import nock from "nock";

const APITALLY_HUB_BASE_URL = "https://hub.apitally.io";
const SALT = "54fd2b80dbfeb87d924affbc91b77c76";
const API_KEY_HASH =
  "bcf46e16814691991c8ed756a7ca3f9cef5644d4f55cd5aaaa5ab4ab4f809208";
export const API_KEY = "7ll40FB.DuHxzQQuGQU4xgvYvTpmnii7K365j9VI";

export const mockApitallyHub = () => {
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
};
