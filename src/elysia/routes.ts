import type { AnyElysia } from "elysia";
import type { RoutePath } from "../startup.js";

const WEBSOCKET_METHODS = new Set(["WS", "$INTERNALWS"]);

export function resolveStartupPaths(app: AnyElysia): RoutePath[] {
  const paths: RoutePath[] = [];
  for (const route of app.routes) {
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
