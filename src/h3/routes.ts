import type { H3, H3Event } from "h3";
import { logDebug, logWarning } from "../logger.js";
import type { RoutePath } from "../startup.js";

export function resolveMatchedRoute(event: H3Event): string | undefined {
  try {
    const route = event.context.matchedRoute?.route;
    return typeof route === "string" ? normalizeRoutePath(route) : undefined;
  } catch (error) {
    logDebug(`Error reading the matched H3 route: ${String(error)}`);
    return undefined;
  }
}

export function resolveStartupPaths(app: H3): RoutePath[] {
  try {
    const routes = (app as unknown as { "~routes"?: unknown })["~routes"];
    if (!Array.isArray(routes)) {
      logWarning(
        "The H3 route registry is unavailable, so Apitally startup information does not include paths.",
      );
      return [];
    }
    const paths: RoutePath[] = [];
    for (const route of routes as { method?: unknown; route?: unknown }[]) {
      const method = route.method;
      const path = route.route;
      if (
        typeof method === "string" &&
        method.length > 0 &&
        method !== "HEAD" &&
        method !== "OPTIONS" &&
        typeof path === "string" &&
        path.length > 0
      ) {
        paths.push({ method, path: normalizeRoutePath(path) });
      }
    }
    return paths;
  } catch (error) {
    logWarning(`Error reading the H3 route registry: ${String(error)}`);
    return [];
  }
}

function normalizeRoutePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
