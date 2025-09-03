import type { Boom } from "@hapi/boom";
import type { RequestRoute, ResponseObject, Server } from "@hapi/hapi";

import { getPackageVersion } from "../common/packageVersions.js";
import type { StartupData } from "../common/types.js";

export function getAppInfo(server: Server, appVersion?: string): StartupData {
  const versions: Array<[string, string]> = [];
  if (process.versions.node) {
    versions.push(["nodejs", process.versions.node]);
  }
  const hapiVersion = getPackageVersion("@hapi/hapi");
  const apitallyVersion = getPackageVersion("../..");
  if (hapiVersion) {
    versions.push(["hapi", hapiVersion]);
  }
  if (apitallyVersion) {
    versions.push(["apitally", apitallyVersion]);
  }
  if (appVersion) {
    versions.push(["app", appVersion]);
  }

  return {
    paths: server
      .table()
      .map((route: RequestRoute) => ({
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
    client: "js:hapi",
  };
}

export function isBoom(response: ResponseObject | Boom): response is Boom {
  return "isBoom" in response && response.isBoom === true;
}
