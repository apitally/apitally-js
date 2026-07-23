import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { peerResolver } from "../logCapture.js";
import { wrapAppFetch } from "./middleware.js";
import { resolveStartupPaths } from "./routes.js";

export type { ApitallyOptions };

// Synchronous setup: records the configuration, registers the startup event
// info, registers the route-recording middleware, and wraps app.fetch.
// Activation itself is triggered by the first request.
export function useApitally(app: Hono, options?: ApitallyOptions): void {
  configure(options);
  registerStartupEventInfo({
    framework: "hono",
    frameworkVersion: resolveHonoVersion(),
    resolvePaths: () => resolveStartupPaths(app),
  });
  wrapAppFetch(app);
}

// hono's exports map does not expose its root package.json, so the version
// comes from walking up from the resolved entry to the package.json named hono.
function resolveHonoVersion(): string | undefined {
  try {
    const entryPath = peerResolver.resolveEntryPath("hono");
    const entryRequire = createRequire(entryPath);
    for (
      let directory = dirname(entryPath);
      dirname(directory) !== directory;
      directory = dirname(directory)
    ) {
      let packageJson: { name?: unknown; version?: unknown };
      try {
        packageJson = entryRequire(join(directory, "package.json")) as {
          name?: unknown;
          version?: unknown;
        };
      } catch {
        continue;
      }
      if (
        packageJson.name === "hono" &&
        typeof packageJson.version === "string"
      ) {
        return packageJson.version;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
