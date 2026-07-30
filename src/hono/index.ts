import type { Hono } from "hono";
import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { resolvePackageVersion } from "../packageVersion.js";
import { wrapAppFetch } from "./middleware.js";
import { resolveStartupPaths } from "./routes.js";

export type { ApitallyOptions };

// Setup stays synchronous; activation begins on the first request.
export function useApitally(app: Hono, options?: ApitallyOptions): void {
  configure(options);
  registerStartupEventInfo({
    framework: "hono",
    frameworkVersion: resolvePackageVersion("hono"),
    resolvePaths: () => resolveStartupPaths(app),
  });
  wrapAppFetch(app);
}
