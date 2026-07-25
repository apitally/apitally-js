import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { configure, registerStartupEventInfo } from "../activation.js";
import type { ApitallyOptions } from "../config.js";
import { peerResolver } from "../logCapture.js";
import { wrapAppFetch } from "./middleware.js";
import { resolveStartupPaths } from "./routes.js";

export type { ApitallyOptions };

// Setup stays synchronous; activation begins on the first request.
export function useApitally(app: Hono, options?: ApitallyOptions): void {
  configure(options);
  registerStartupEventInfo({
    framework: "hono",
    frameworkVersion: resolveHonoVersion(),
    resolvePaths: () => resolveStartupPaths(app),
  });
  wrapAppFetch(app);
}

// Hono's exports map hides its package.json, so version lookup walks from the
// resolved `hono` entry to its owning package.
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
