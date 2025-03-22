import type { HttpContext } from "@adonisjs/core/http";

import type { ApitallyConfig } from "../common/types.js";
export type { ApitallyConfig, ApitallyConsumer } from "../common/types.js";

export const defineConfig = (config: ApitallyConfig) => {
  return config;
};

export const captureError = (error: unknown, ctx: HttpContext) => {
  if (error instanceof Error) {
    ctx.apitallyError = error;
  }
};
