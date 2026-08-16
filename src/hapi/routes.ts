import type { Request, Server } from "@hapi/hapi";
import type { RoutePath } from "../startup.js";

export function resolveStartupPaths(server: Server): RoutePath[] {
  return server
    .table()
    .filter((route) => route.method !== "*")
    .map((route) => ({ method: route.method, path: route.path }));
}

export function resolveRequestRoute(request: Request): string | undefined {
  const matchedRoute = request.server.match(request.method, request.path, request.info.hostname);
  return matchedRoute ? request.route.path : undefined;
}
