import type { FastifyRequest, RouteOptions } from "fastify";
import type { RoutePath } from "../startup.js";

export function addStartupPaths(paths: RoutePath[], routeOptions: RouteOptions): void {
  const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
  for (const method of methods) {
    paths.push({ method, path: routeOptions.url });
  }
}

export function resolveRequestRoute(request: FastifyRequest): string | undefined {
  return request.is404 ? undefined : request.routeOptions.url;
}
