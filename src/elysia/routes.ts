import type { AnyElysia } from "elysia";
import type { RoutePath } from "../startup.js";

const WEBSOCKET_METHODS = new Set(["WS", "$INTERNALWS"]);

// For a plugin, Elysia's getGlobalRoutes() returns the routes of the app it is
// mounted on. The official @elysiajs/openapi plugin relies on the same method.
export function resolveStartupPaths(app: AnyElysia): RoutePath[] {
  const routes = (app as unknown as { getGlobalRoutes(): AnyElysia["routes"] }).getGlobalRoutes();
  const paths: RoutePath[] = [];
  for (const route of routes) {
    if (
      typeof route.method === "string" &&
      typeof route.path === "string" &&
      !WEBSOCKET_METHODS.has(route.method.toUpperCase())
    ) {
      paths.push({ method: route.method, path: route.path });
    }
  }
  return paths;
}
