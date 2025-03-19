import { Router } from "@adonisjs/core/http";
import { ApplicationService } from "@adonisjs/core/types";
import { ApitallyClient } from "../common/client.js";
import { getPackageVersion } from "../common/packageVersions.js";
import { ApitallyConfig, PathInfo, StartupData } from "../common/types.js";

declare module "@adonisjs/core/types" {
  interface ContainerBindings {
    apitallyClient: ApitallyClient;
  }
}

export default class ApitallyProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton("apitallyClient", () => {
      const config: ApitallyConfig = {
        clientId: this.app.config.get("apitally.clientId"),
      };
      return new ApitallyClient(config);
    });
  }

  async ready() {
    const apitallyClient = await this.app.container.make("apitallyClient");
    const router = await this.app.container.make("router");
    const paths = listRoutes(router);
    const versions = getVersions(this.app.config.get("apitally.appVersion"));
    const startupData: StartupData = {
      paths,
      versions,
      client: "js:adonisjs",
    };
    apitallyClient.setStartupData(startupData);
  }

  async shutdown() {
    const apitallyClient = await this.app.container.make("apitallyClient");
    await apitallyClient.handleShutdown();
  }
}

const listRoutes = (router: Router) => {
  const routes = router.toJSON();
  const paths: Array<PathInfo> = [];
  for (const domain in routes) {
    for (const route of routes[domain]) {
      for (const method of route.methods) {
        paths.push({
          method: method.toUpperCase(),
          path: route.pattern,
        });
      }
    }
  }
  return paths;
};

const getVersions = (appVersion?: string) => {
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
};
