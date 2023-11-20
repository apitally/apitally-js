import { Test } from "@nestjs/testing";

import { useApitally } from "../../src/nestjs";
import { AppModule } from "./app.module";

const CLIENT_ID = "fa4f144d-33be-4694-95e4-f5c18b0f151d";
const ENV = "default";

export async function getApp() {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
    providers: [],
  }).compile();
  const app = moduleFixture.createNestApplication();
  const expressInstance = app.getHttpAdapter().getInstance();

  useApitally(expressInstance, {
    clientId: CLIENT_ID,
    env: ENV,
    syncApiKeys: true,
    appVersion: "1.2.3",
  });

  await app.init();
  return app;
}
