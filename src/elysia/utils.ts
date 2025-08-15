import type { Elysia } from "elysia";

import { getPackageVersion } from "../common/packageVersions.js";
import type { StartupData } from "../common/types.js";

export function getAppInfo(app: Elysia, appVersion?: string): StartupData {
  const versions: Array<[string, string]> = [];
  if (process.versions.node) {
    versions.push(["nodejs", process.versions.node]);
  }
  if (process.versions.bun) {
    versions.push(["bun", process.versions.bun]);
  }
  const elysiaVersion = getPackageVersion("elysia");
  const apitallyVersion = getPackageVersion("../..");
  if (elysiaVersion) {
    versions.push(["elysia", elysiaVersion]);
  }
  if (apitallyVersion) {
    versions.push(["apitally", apitallyVersion]);
  }
  if (appVersion) {
    versions.push(["app", appVersion]);
  }

  return {
    paths: app.routes
      .map((route) => ({
        method: route.method.toUpperCase(),
        path: route.path,
      }))
      .filter(
        (route) =>
          route.method &&
          route.path &&
          !["HEAD", "OPTIONS"].includes(route.method),
      ),
    versions: Object.fromEntries(versions),
    client: "js:elysia",
  };
}
