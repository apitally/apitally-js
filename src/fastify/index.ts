import type { FastifyInstance } from "fastify";
import type { ApitallyOptions } from "../config.js";
import { resolvePackageVersion } from "../packageVersion.js";
import { installFastifyIntegration } from "./install.js";

export type { ApitallyOptions };

export function useApitally(app: FastifyInstance, options?: ApitallyOptions): void {
  installFastifyIntegration(app, options, {
    framework: "fastify",
    frameworkVersion: resolvePackageVersion("fastify"),
  });
}
