import type { Context, Hono } from "hono";
import { logDebug } from "../logger.js";
import type { RoutePath } from "../startup.js";

export interface MatchedRouteResult {
  route?: string;
}

interface MatchedRouteEntry {
  path?: unknown;
  method?: unknown;
  handler?: unknown;
}

// Handlers composed at app.route() mount time hold the original under this
// property (Hono's own convention).
const COMPOSED_HANDLER_PROPERTY = "__COMPOSED_HANDLER";

// Hono match entries include app.route() mount prefixes. Handler arity
// distinguishes route handlers from middleware.
export function resolveMatchedRoute(c: Context): MatchedRouteResult {
  const entries = readMatchedRouteEntries(c);
  if (!entries) {
    return {};
  }
  // Scanning from `routeIndex` finds the matched route when middleware responds
  // before its handler.
  for (let index = c.req.routeIndex; index < entries.length; index++) {
    const entry = entries[index];
    if (entry && isRouteHandler(entry.handler)) {
      return {
        route: typeof entry.path === "string" ? entry.path : undefined,
      };
    }
  }
  return {};
}

export function resolveStartupPaths(app: Hono): RoutePath[] {
  const paths: RoutePath[] = [];
  const seenPaths = new Set<string>();
  for (const route of app.routes) {
    const method = route.method.toUpperCase();
    if (method === "ALL" || !isRouteHandler(route.handler)) {
      continue;
    }
    const key = `${method} ${route.path}`;
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      paths.push({ method, path: route.path });
    }
  }
  return paths;
}

// Hono route helpers use build-private Symbols, so ESM helpers cannot read CJS
// requests. The request instance getter always uses the matching build.
function readMatchedRouteEntries(c: Context): MatchedRouteEntry[] | undefined {
  try {
    const entries = (c.req as { matchedRoutes?: unknown }).matchedRoutes;
    return Array.isArray(entries)
      ? (entries as MatchedRouteEntry[])
      : undefined;
  } catch (error) {
    logDebug(`Error reading the matched hono routes: ${String(error)}`);
    return undefined;
  }
}

function isRouteHandler(handler: unknown): boolean {
  let target = handler;
  while (typeof target === "function") {
    const composed = (target as unknown as Record<string, unknown>)[
      COMPOSED_HANDLER_PROPERTY
    ];
    if (composed === undefined) {
      break;
    }
    target = composed;
  }
  return typeof target === "function" && target.length <= 1;
}
