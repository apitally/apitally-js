import type { FastifyInstance } from "fastify";
import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { resolvePackageVersion } from "../packageVersion.js";
import type { RoutePath } from "../startup.js";
import { installFastifyHooks } from "./middleware.js";

export type { ApitallyOptions };

export function useApitally(app: FastifyInstance, options?: ApitallyOptions): void {
  configure(options);
  const startupPaths: RoutePath[] = [];
  registerStartupEventInfo({
    framework: "fastify",
    frameworkVersion: resolvePackageVersion("fastify"),
    resolvePaths: () => startupPaths,
  });
  installFastifyHooks(app, startupPaths);
}
