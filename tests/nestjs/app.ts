import { Test } from "@nestjs/testing";

import { useApitally } from "../../src/nestjs/index.js";
import { CLIENT_ID, ENV } from "../utils.js";
import { AppModule } from "./app.module.js";

export async function getApp() {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
    providers: [],
  }).compile();
  const app = moduleFixture.createNestApplication();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    appVersion: "1.2.3",
    requestLoggingConfig: {
      enabled: true,
      logQueryParams: true,
      logRequestHeaders: true,
      logRequestBody: true,
      logResponseHeaders: true,
      logResponseBody: true,
    },
  });

  await app.init();
  return app;
}
