import type { Router } from "@adonisjs/core/http";
import type { ApplicationService } from "@adonisjs/core/types";
import { AsyncLocalStorage } from "node:async_hooks";

import { ApitallyClient } from "../common/client.js";
import { getPackageVersion } from "../common/packageVersions.js";
import type { LogRecord } from "../common/requestLogger.js";
import type { ApitallyConfig, PathInfo, StartupData } from "../common/types.js";
import { patchConsole, patchPinoLogger } from "../loggers/index.js";

declare module "@adonisjs/core/types" {
  interface ContainerBindings {
    apitallyClient: ApitallyClient;
    apitallyLogsContext: AsyncLocalStorage<LogRecord[]>;
  }
}

export default class ApitallyProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton("apitallyClient", () => {
      const config: ApitallyConfig = this.app.config.get("apitally");
      return new ApitallyClient(config);
    });
    this.app.container.singleton("apitallyLogsContext", () => {
      return new AsyncLocalStorage<LogRecord[]>();
    });
  }

  async start() {
    const client = await this.app.container.make("apitallyClient");
    if (client.requestLogger.config.captureLogs) {
      const logsContext = await this.app.container.make("apitallyLogsContext");
      const logger = await this.app.container.make("logger");

      patchPinoLogger(logger.pino, logsContext);
      patchConsole(logsContext);
    }
  }

  async ready() {
    const client = await this.app.container.make("apitallyClient");
    const router = await this.app.container.make("router");

    const paths = listRoutes(router);
    const versions = getVersions(this.app.config.get("apitally.appVersion"));
    const startupData: StartupData = {
      paths,
      versions,
      client: "js:adonisjs",
    };
    client.setStartupData(startupData);
    client.startSync();
  }

  async shutdown() {
    const client = await this.app.container.make("apitallyClient");
    await client.handleShutdown();
  }
}

function listRoutes(router: Router) {
  const routes = router.toJSON();
  const paths: Array<PathInfo> = [];
  for (const domain in routes) {
    for (const route of routes[domain]) {
      for (const method of route.methods) {
        if (!["HEAD", "OPTIONS"].includes(method.toUpperCase())) {
          paths.push({
            method: method.toUpperCase(),
            path: route.pattern,
          });
        }
      }
    }
  }
  return paths;
}

function getVersions(appVersion?: string) {
  const versions = [["nodejs", process.version.replace(/^v/, "")]];
  const adonisJsVersion = getPackageVersion("@adonisjs/core");
  const apitallyVersion = getPackageVersion("../..");
  if (adonisJsVersion) {
    versions.push(["adonisjs", adonisJsVersion]);
  }
  if (apitallyVersion) {
    versions.push(["apitally", apitallyVersion]);
  }
  if (appVersion) {
    versions.push(["app", appVersion]);
  }
  return Object.fromEntries(versions);
}
