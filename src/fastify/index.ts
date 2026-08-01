import type { FastifyInstance } from "fastify";
import type { ApitallyOptions } from "../config.js";
import { resolvePackageVersion } from "../packageVersion.js";
import { installFastifyAdapter } from "./adapter.js";

export type { ApitallyOptions };

export function useApitally(app: FastifyInstance, options?: ApitallyOptions): void {
  installFastifyAdapter(app, options, {
    framework: "fastify",
    frameworkVersion: resolvePackageVersion("fastify"),
  });
}
