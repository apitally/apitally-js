import type { HttpContext } from "@adonisjs/core/http";

import type { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
export type { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
export { configure } from "./configure.js";

export function defineConfig(config: ApitallyConfig) {
  return config;
}

export function captureError(error: unknown, ctx: HttpContext) {
  if (error instanceof Error) {
    ctx.apitallyError = error;
  }
}

export function setConsumer(
  ctx: HttpContext,
  consumer: ApitallyConsumer | string | null | undefined,
) {
  ctx.apitallyConsumer = consumer || undefined;
}
