import { H3Core } from "h3";

import { getPackageVersion } from "../common/packageVersions.js";

export function getAppInfo(h3: H3Core, appVersion?: string) {
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
    paths: h3["~routes"]
      .map((route) => ({
        method: route.method || "",
        path: route.route || "",
      }))
      .filter(
        (route) =>
          route.method &&
          route.path &&
          !["HEAD", "OPTIONS"].includes(route.method.toUpperCase()),
      ),
    versions: Object.fromEntries(versions),
    client: "js:h3",
  };
}
