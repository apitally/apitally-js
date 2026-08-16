import type { Server } from "@hapi/hapi";
import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { installHapiHooks } from "./middleware.js";
import { resolveStartupPaths } from "./routes.js";

const INSTALL_MARKER = Symbol.for("apitally.hapiInstall");

export function installHapiIntegration(server: Server, options?: ApitallyOptions): void {
  configure(options);
  const listener = server.listener as unknown as Record<symbol, boolean | undefined>;
  if (listener[INSTALL_MARKER] === true) {
    return;
  }
  listener[INSTALL_MARKER] = true;
  registerStartupEventInfo({
    framework: "hapi",
    frameworkVersion: server.version,
    resolvePaths: () => resolveStartupPaths(server),
  });
  installHapiHooks(server);
}
