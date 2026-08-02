import type Koa = require("koa");

import { logDebug } from "../logger.js";
import type { RoutePath } from "../startup.js";

interface KoaRouterContext {
  _matchedRoute?: unknown;
  routePath?: unknown;
}

interface KoaRouterMiddleware {
  router?: {
    stack?: unknown;
  };
}

interface KoaRouterLayer {
  methods?: unknown;
  path?: unknown;
}

export function resolveMatchedRoute(ctx: Koa.Context): string | undefined {
  try {
    const routerContext = ctx as Koa.Context & KoaRouterContext;
    return (
      resolveRoutePath(routerContext._matchedRoute) ?? resolveRoutePath(routerContext.routePath)
    );
  } catch (error) {
    logDebug(`Error reading the matched koa route: ${String(error)}`);
    return undefined;
  }
}

export function resolveStartupPaths(app: Koa): RoutePath[] {
  const paths: RoutePath[] = [];
  try {
    for (const middleware of app.middleware as KoaRouterMiddleware[]) {
      const stack = middleware.router?.stack;
      if (!Array.isArray(stack)) {
        continue;
      }
      for (const layer of stack as KoaRouterLayer[]) {
        const path = resolveRoutePath(layer.path);
        if (!path || !Array.isArray(layer.methods)) {
          continue;
        }
        for (const method of layer.methods) {
          if (typeof method === "string") {
            paths.push({ method, path });
          }
        }
      }
    }
  } catch (error) {
    logDebug(`Error reading the koa app's routes: ${String(error)}`);
  }
  return paths;
}

function resolveRoutePath(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof RegExp ? value.toString() : undefined;
}
