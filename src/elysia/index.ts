import { type AnyElysia, Elysia } from "elysia";
import type { ApitallyOptions } from "../config.js";
import { createElysiaPlugin, installElysiaIntegration } from "./middleware.js";

export type { ApitallyOptions };

export function apitallyPlugin(options?: ApitallyOptions): Elysia {
  return createElysiaPlugin(Elysia, options) as Elysia;
}

// Setup stays synchronous; activation begins on the first request.
export function useApitally(app: AnyElysia, options?: ApitallyOptions): void {
  installElysiaIntegration(app, options);
}
