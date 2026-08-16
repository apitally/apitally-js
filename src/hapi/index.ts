import type { Plugin, Server } from "@hapi/hapi";
import type { ApitallyOptions } from "../config.js";
import { installHapiIntegration } from "./install.js";

export type { ApitallyOptions };

export function apitallyPlugin(options?: ApitallyOptions): Plugin<undefined> {
  return {
    name: "apitally",
    once: true,
    requirements: { hapi: ">=21 <22" },
    register: (server) => installHapiIntegration(server, options),
  };
}

export function useApitally(server: Server, options?: ApitallyOptions): void {
  installHapiIntegration(server, options);
}
