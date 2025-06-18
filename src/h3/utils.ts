import { H3, H3Route } from "h3";

import { getPackageVersion } from "../common/packageVersions.js";

export function getAppInfo(h3: H3, appVersion?: string) {
  const routes = h3._routes ? listAllRoutes<H3Route>(h3._routes.root) : [];

  const versions: Array<[string, string]> = [];
  if (process.versions.node) {
    versions.push(["nodejs", process.versions.node]);
  }
  if (process.versions.bun) {
    versions.push(["bun", process.versions.bun]);
  }
  const h3Version = getPackageVersion("h3");
  const apitallyVersion = getPackageVersion("../..");
  if (h3Version) {
    versions.push(["h3", h3Version]);
  }
  if (apitallyVersion) {
    versions.push(["apitally", apitallyVersion]);
  }
  if (appVersion) {
    versions.push(["app", appVersion]);
  }

  return {
    paths: routes
      .map((route) => ({
        method: route.method || "",
        path: route.route || "",
      }))
      .filter((route) => route.method && route.path),
    versions: Object.fromEntries(versions),
    client: "js:h3",
  };
}

// Types from rou3
type MethodData<T = unknown> = { data: T };
interface Node<T = unknown> {
  key: string;
  static?: Record<string, Node<T>>;
  param?: Node<T>;
  wildcard?: Node<T>;
  methods?: Record<string, MethodData<T>[] | undefined>;
}

function listAllRoutes<T>(node: Node<T>): T[] {
  const routes: T[] = [];
  _collectAllRoutes(node, routes);
  return routes;
}

function _collectAllRoutes<T>(node: Node<T>, routes: T[] = []): void {
  // Collect routes from current node methods
  if (node.methods) {
    for (const methodData of Object.values(node.methods)) {
      if (Array.isArray(methodData)) {
        for (const item of methodData) {
          if (item.data) {
            routes.push(item.data);
          }
        }
      }
    }
  }

  // Traverse static children
  if (node.static) {
    for (const staticChild of Object.values(node.static)) {
      _collectAllRoutes(staticChild, routes);
    }
  }

  // Traverse param child
  if (node.param) {
    _collectAllRoutes(node.param, routes);
  }

  // Traverse wildcard child
  if (node.wildcard) {
    _collectAllRoutes(node.wildcard, routes);
  }
}
