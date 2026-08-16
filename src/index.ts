import { configure as configureAdonis } from "./adonisjs/configure.js";
import type { ApitallyOptions } from "./config.js";
import { installElysiaIntegration } from "./elysia/middleware.js";
import { useApitally as useApitallyExpress } from "./express/index.js";
import { useApitally as useApitallyFastify } from "./fastify/index.js";
import { useApitally as useApitallyH3 } from "./h3/index.js";
import { useApitally as useApitallyHapi } from "./hapi/index.js";
import { useApitally as useApitallyHono } from "./hono/index.js";
import { useApitally as useApitallyKoa } from "./koa/index.js";

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

/** AdonisJS Ace configuration hook. */
export function configure(command: unknown): Promise<void> {
  return configureAdonis(command as Parameters<typeof configureAdonis>[0]);
}

export function useApitally(app: unknown, options?: ApitallyOptions): void {
  if (isExpressApp(app)) {
    useApitallyExpress(app, options);
  } else if (isFastifyApp(app)) {
    useApitallyFastify(app, options);
  } else if (isHapiServer(app)) {
    useApitallyHapi(app, options);
  } else if (isH3App(app)) {
    useApitallyH3(app, options);
  } else if (isElysiaApp(app)) {
    installElysiaIntegration(app, options);
  } else if (isHonoApp(app)) {
    useApitallyHono(app, options);
  } else if (isKoaApp(app)) {
    useApitallyKoa(app, options);
  } else {
    throw new TypeError(
      "useApitally() could not detect a supported framework from the app argument",
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

function isHapiServer(app: unknown): app is Parameters<typeof useApitallyHapi>[0] {
  const candidate = app as {
    ext?: unknown;
    register?: unknown;
    route?: unknown;
    table?: unknown;
    initialize?: unknown;
    start?: unknown;
    stop?: unknown;
  };
  return (
    typeof app === "object" &&
    app !== null &&
    typeof candidate.ext === "function" &&
    typeof candidate.register === "function" &&
    typeof candidate.route === "function" &&
    typeof candidate.table === "function" &&
    typeof candidate.initialize === "function" &&
    typeof candidate.start === "function" &&
    typeof candidate.stop === "function"
  );
}

function isH3App(app: unknown): app is Parameters<typeof useApitallyH3>[0] {
  const candidate = app as {
    constructor?: Record<string, unknown>;
    fetch?: unknown;
    request?: unknown;
    use?: unknown;
  };
  return (
    typeof app === "object" &&
    app !== null &&
    candidate.constructor?.["~h3"] === true &&
    typeof candidate.fetch === "function" &&
    typeof candidate.request === "function" &&
    typeof candidate.use === "function"
  );
}

function isElysiaApp(app: unknown): app is Parameters<typeof installElysiaIntegration>[0] {
  const candidate = app as {
    routes?: unknown;
    handle?: unknown;
    route?: unknown;
    wrap?: unknown;
    onTransform?: unknown;
    onError?: unknown;
  };
  // Avoid reading app.fetch, as it compiles Elysia before the integration can be installed
  return (
    typeof app === "object" &&
    app !== null &&
    Array.isArray(candidate.routes) &&
    typeof candidate.handle === "function" &&
    typeof candidate.route === "function" &&
    typeof candidate.wrap === "function" &&
    typeof candidate.onTransform === "function" &&
    typeof candidate.onError === "function"
  );
}

function isKoaApp(app: unknown): app is Parameters<typeof useApitallyKoa>[0] {
  const candidate = app as {
    middleware?: unknown;
    use?: unknown;
    callback?: unknown;
  };
  return (
    typeof app === "object" &&
    app !== null &&
    Array.isArray(candidate.middleware) &&
    typeof candidate.use === "function" &&
    typeof candidate.callback === "function"
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
