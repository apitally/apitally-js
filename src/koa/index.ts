import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { resolvePackageVersion } from "../packageVersion.js";
import { installKoaMiddleware } from "./middleware.js";
import { resolveStartupPaths } from "./routes.js";

export type { ApitallyOptions };

// Setup stays synchronous; activation begins on the first request.
export function useApitally(app: import("koa"), options?: ApitallyOptions): void {
  configure(options);
  registerStartupEventInfo({
    framework: "koa",
    frameworkVersion: resolvePackageVersion("koa"),
    resolvePaths: () => resolveStartupPaths(app),
  });
  installKoaMiddleware(app);
}
