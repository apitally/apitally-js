import type { ApitallyOptions } from "./config.js";
import { useApitally as useApitallyExpress } from "./express/index.js";
import { useApitally as useApitallyFastify } from "./fastify/index.js";
import { useApitally as useApitallyHono } from "./hono/index.js";

export { shutdown } from "./activation.js";
export type {
  ApitallyOptions,
  BodyMaskingCallback as BodyMaskCallback,
  SamplingCallback,
} from "./config.js";
export type { ApitallyConsumer } from "./consumer.js";
export { setConsumer } from "./consumer.js";
export { captureException } from "./exceptions.js";
export { setRequestAttribute } from "./requestAttributes.js";
export { ApitallySpanProcessor } from "./spanProcessor.js";
export { instrument, span } from "./tracing.js";

export function useApitally(app: unknown, options?: ApitallyOptions): void {
  if (isExpressApp(app)) {
    useApitallyExpress(app, options);
  } else if (isFastifyApp(app)) {
    useApitallyFastify(app, options);
  } else if (isHonoApp(app)) {
    useApitallyHono(app, options);
  } else {
    throw new TypeError(
      'useApitally() could not detect a supported framework from the app argument. To resolve this, use the framework-specific entry point instead: import { useApitally } from "apitally/express" for Express, from "apitally/fastify" for Fastify, or from "apitally/hono" for Hono.',
    );
  }
}

function isExpressApp(app: unknown): app is Parameters<typeof useApitallyExpress>[0] {
  const candidate = app as {
    use?: unknown;
    handle?: unknown;
  };
  return (
    typeof app === "function" &&
    typeof candidate.use === "function" &&
    typeof candidate.handle === "function"
  );
}

function isFastifyApp(app: unknown): app is Parameters<typeof useApitallyFastify>[0] {
  const candidate = app as {
    version?: unknown;
    addHook?: unknown;
    register?: unknown;
    route?: unknown;
    ready?: unknown;
    close?: unknown;
  };
  return (
    typeof app === "object" &&
    app !== null &&
    typeof candidate.version === "string" &&
    typeof candidate.addHook === "function" &&
    typeof candidate.register === "function" &&
    typeof candidate.route === "function" &&
    typeof candidate.ready === "function" &&
    typeof candidate.close === "function"
  );
}

function isHonoApp(app: unknown): app is Parameters<typeof useApitallyHono>[0] {
  const candidate = app as {
    routes?: unknown;
    fetch?: unknown;
    route?: unknown;
  };
  return (
    typeof app === "object" &&
    app !== null &&
    Array.isArray(candidate.routes) &&
    typeof candidate.fetch === "function" &&
    typeof candidate.route === "function"
  );
}
