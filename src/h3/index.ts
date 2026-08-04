import type { H3, H3Plugin } from "h3";
import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { resolvePackageVersion } from "../packageVersion.js";
import { installH3RequestObservation } from "./middleware.js";
import { resolveStartupPaths } from "./routes.js";

export type { ApitallyOptions };

const INSTALL_MARKER = Symbol.for("apitally.installMarker");

export function apitallyPlugin(options?: ApitallyOptions): H3Plugin {
  return (app) => install(app, options);
}

// Setup stays synchronous; activation begins on the first request.
export function useApitally(app: H3, options?: ApitallyOptions): void {
  install(app, options);
}

function install(app: H3, options?: ApitallyOptions): void {
  configure(options);
  const markedApp = app as unknown as Record<symbol, boolean | undefined>;
  if (markedApp[INSTALL_MARKER] === true) {
    return;
  }
  markedApp[INSTALL_MARKER] = true;
  registerStartupEventInfo({
    framework: "h3",
    frameworkVersion: resolvePackageVersion("h3"),
    resolvePaths: () => resolveStartupPaths(app),
  });
  installH3RequestObservation(app);
}
