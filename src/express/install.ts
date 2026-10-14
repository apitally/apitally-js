import type { Express } from "express";
import {
  activateWhenHttpServerListens,
  configure,
  registerStartupEventInfo,
} from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { logDebug } from "../logger.js";
import type { StartupEventInfo } from "../startup.js";
import { wrapAppHandle } from "./middleware.js";
import { installRouteCaptureFromApp, resolveStartupPaths } from "./routes.js";

export function installExpressIntegration(
  app: Express,
  options: ApitallyOptions | undefined,
  frameworkInfo: Pick<StartupEventInfo, "framework" | "frameworkVersion">,
): void {
  configure(options);
  activateWhenHttpServerListens();
  registerStartupEventInfo({
    ...frameworkInfo,
    resolvePaths: () => resolveStartupPaths(app),
  });
  try {
    installRouteCaptureFromApp(app);
  } catch (error) {
    logDebug(`Error installing the express route capture: ${String(error)}`);
  }
  wrapAppHandle(app);
}
