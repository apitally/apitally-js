import type { ApplicationService, HttpRouterService } from "@adonisjs/core/types";
import { activate, configure, registerStartupEventInfo, shutdown } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { resolvePackageVersion } from "../packageVersion.js";
import type { RoutePath } from "../startup.js";

export default class ApitallyProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {
    configure(this.app.config.get<ApitallyOptions>("apitally"));
  }

  async ready(): Promise<void> {
    if (this.app.getEnvironment() !== "web") {
      return;
    }
    const router = await this.app.container.make("router");
    registerStartupEventInfo({
      framework: "adonisjs",
      frameworkVersion: resolvePackageVersion("@adonisjs/core"),
      resolvePaths: () => resolvePaths(router),
    });
    activate();
  }

  async shutdown(): Promise<void> {
    await shutdown();
  }
}

function resolvePaths(router: HttpRouterService): RoutePath[] {
  return Object.values(router.toJSON()).flatMap((routes) =>
    routes.flatMap((route) => route.methods.map((method) => ({ method, path: route.pattern }))),
  );
}
