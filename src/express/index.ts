import type { Express } from "express";
import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { logDebug } from "../logger.js";
import { resolvePackageVersion } from "../packageVersion.js";
import { wrapAppHandle } from "./middleware.js";
import { installRouteCaptureFromApp, resolveStartupPaths } from "./routes.js";

export type { ApitallyOptions };

// Setup stays synchronous; activation begins on the first request.
export function useApitally(app: Express, options?: ApitallyOptions): void {
  configure(options);
  registerStartupEventInfo({
    framework: "express",
    frameworkVersion: resolvePackageVersion("express"),
    resolvePaths: () => resolveStartupPaths(app),
  });
  try {
    installRouteCaptureFromApp(app);
  } catch (error) {
    logDebug(`Error installing the express route capture: ${String(error)}`);
  }
  wrapAppHandle(app);
}
