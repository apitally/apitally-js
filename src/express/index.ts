import { createRequire } from "node:module";
import type { Express } from "express";
import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { resolvePeerEntryPath } from "../logCapture.js";
import { logDebug } from "../logger.js";
import { wrapAppHandle } from "./middleware.js";
import { installRouteCaptureFromApp, resolveStartupPaths } from "./routes.js";

export type { ApitallyOptions };

// Setup stays synchronous; activation begins on the first request.
export function useApitally(app: Express, options?: ApitallyOptions): void {
  configure(options);
  registerStartupEventInfo({
    framework: "express",
    frameworkVersion: resolveExpressVersion(),
    resolvePaths: () => resolveStartupPaths(app),
  });
  try {
    installRouteCaptureFromApp(app);
  } catch (error) {
    logDebug(`Error installing the express route capture: ${String(error)}`);
  }
  wrapAppHandle(app);
}

function resolveExpressVersion(): string | undefined {
  try {
    const entryPath = resolvePeerEntryPath("express");
    const packageJson = createRequire(entryPath)("./package.json") as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : undefined;
  } catch {
    return undefined;
  }
}
