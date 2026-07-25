import type { Express } from "express";
import type { Hono } from "hono";
import type { ApitallyOptions } from "./config.js";
import { useApitally as useApitallyExpress } from "./express/index.js";
import { useApitally as useApitallyHono } from "./hono/index.js";

export { shutdown } from "./activation.js";
export type {
  ApitallyOptions,
  BodyMaskCallback,
  SamplingCallback,
} from "./config.js";
export type { ApitallyConsumer } from "./consumer.js";
export {
  ApitallySpanProcessor,
  captureException,
  setConsumer,
  setRequestAttribute,
} from "./spanProcessor.js";
export { instrument, span } from "./tracing.js";

export function useApitally(app: Express, options?: ApitallyOptions): void;
export function useApitally(app: Hono, options?: ApitallyOptions): void;
export function useApitally(app: unknown, options?: ApitallyOptions): void {
  if (isExpressApp(app)) {
    useApitallyExpress(app, options);
  } else if (isHonoApp(app)) {
    useApitallyHono(app, options);
  } else {
    throw new TypeError(
      'useApitally() could not detect a supported framework from the app argument. To resolve this, use the framework-specific entry point instead: import { useApitally } from "apitally/express" for Express or from "apitally/hono" for Hono.',
    );
  }
}

// Duck typing avoids runtime framework imports from the root entry. Express is
// a handler with application methods; Hono exposes its routes and fetch handler.
function isExpressApp(app: unknown): app is Express {
  const candidate = app as { use?: unknown; handle?: unknown };
  return (
    typeof app === "function" &&
    typeof candidate.use === "function" &&
    typeof candidate.handle === "function"
  );
}

function isHonoApp(app: unknown): app is Hono {
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
