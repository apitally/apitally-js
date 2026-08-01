import type { FastifyInstance } from "fastify";
import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import type { RoutePath, StartupEventInfo } from "../startup.js";
import { installFastifyHooks } from "./middleware.js";

export function installFastifyAdapter(
  app: FastifyInstance,
  options: ApitallyOptions | undefined,
  startupIdentity: Pick<StartupEventInfo, "framework" | "frameworkVersion">,
): void {
  configure(options);
  const startupPaths: RoutePath[] = [];
  registerStartupEventInfo({
    ...startupIdentity,
    resolvePaths: () => startupPaths,
  });
  installFastifyHooks(app, startupPaths);
}
