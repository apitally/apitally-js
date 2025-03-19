export type { ApitallyConsumer } from "../common/types.js";
import { ApitallyConfig } from "../common/types.js";
import { configureStartupData } from "./startup.js";
import { ApitallyClient } from "../common/client.js";

let client: ApitallyClient;

export const getApitallyClient = () => {
  return client;
};

export const useApitally = (app: any, config: ApitallyConfig) => {
  client = new ApitallyClient(config);

  // Set startup data after a short delay to ensure routes are registered
  setTimeout(() => {
    configureStartupData(app, config);
  }, 1000);
};
