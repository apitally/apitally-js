import type { Context, Hono } from "hono";
import { logDebug } from "../logger.js";
import type { RoutePath } from "../startup.js";

// Route templates come from Hono's match result: app.route() re-registers a
// sub-app's routes on the parent at mount time with the mount prefix included
// in the registered path, so matched templates carry mount prefixes by construction.

export interface MatchedRouteResult {
  route?: string;
  matched: boolean;
}

interface MatchedRouteEntry {
  path?: unknown;
  method?: unknown;
  handler?: unknown;
}

// Handlers composed at app.route() mount time hold the original under this
// property (Hono's own convention).
const COMPOSED_HANDLER_PROPERTY = "__COMPOSED_HANDLER";

// Resolves the request's route template and match state after the middleware
// chain unwound. Real route handlers are discriminated from middleware entries
// by handler arity, Hono's own convention: route handlers take one argument.
export function resolveMatchedRoute(c: Context): MatchedRouteResult {
  const entries = readMatchedRouteEntries(c);
  if (!entries) {
    return { matched: false };
  }
  // routeIndex points at the handler the response came from; a middleware that
  // responded without calling next() leaves the route handler it preempted at
  // a later index in the match result.
  for (let index = c.req.routeIndex; index < entries.length; index++) {
    const entry = entries[index];
    if (entry && isRouteHandler(entry.handler)) {
      return {
        route: typeof entry.path === "string" ? entry.path : undefined,
        matched: true,
      };
    }
  }
  return { matched: false };
}

// Enumerates the app's registered routes for the startup event, filtering
// middleware entries by the arity convention and deduplicating method-path pairs.
export function resolveStartupPaths(app: Hono): RoutePath[] {
  const paths: RoutePath[] = [];
  const seen = new Set<string>();
  for (const route of app.routes) {
    const method = route.method.toUpperCase();
    if (method === "ALL" || !isRouteHandler(route.handler)) {
      continue;
    }
    const key = `${method} ${route.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      paths.push({ method, path: route.path });
    }
  }
  return paths;
}

// The hono/route helpers read the match result through a getter keyed by a
// Symbol private to the hono build variant (ESM or CJS) that constructed the
// request, so a helper the SDK resolves via createRequire cannot read requests
// created by an app loaded through the other build. The equivalent getter on
// the HonoRequest instance is variant-safe by construction.
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
