import type { Express } from "express";
import type { ApitallyOptions } from "../config.js";
import { resolvePackageVersion } from "../packageVersion.js";
import { installExpressAdapter } from "./adapter.js";

export type { ApitallyOptions };

// Setup stays synchronous; activation begins on the first request.
export function useApitally(app: Express, options?: ApitallyOptions): void {
  installExpressAdapter(app, options, {
    framework: "express",
    frameworkVersion: resolvePackageVersion("express"),
  });
}
