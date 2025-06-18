import { Hono } from "hono";
import { isMiddleware } from "hono/utils/handler";
import type { ZodError } from "zod";

import { getPackageVersion } from "../common/packageVersions.js";
import { PathInfo, StartupData, ValidationError } from "../common/types.js";

export function getAppInfo(app: Hono, appVersion?: string): StartupData {
  const versions: Array<[string, string]> = [];
  if (process.versions.node) {
    versions.push(["nodejs", process.versions.node]);
  }
  if (process.versions.bun) {
    versions.push(["bun", process.versions.bun]);
  }
  const honoVersion = getPackageVersion("hono");
  const apitallyVersion = getPackageVersion("../..");
  if (honoVersion) {
    versions.push(["hono", honoVersion]);
  }
  if (apitallyVersion) {
    versions.push(["apitally", apitallyVersion]);
  }
  if (appVersion) {
    versions.push(["app", appVersion]);
  }
  return {
    paths: listEndpoints(app),
    versions: Object.fromEntries(versions),
    client: "js:hono",
  };
}

export function listEndpoints(app: Hono) {
  const endpoints: Array<PathInfo> = [];
  app.routes.forEach((route) => {
    if (route.method !== "ALL" && !isMiddleware(route.handler)) {
      endpoints.push({
        method: route.method.toUpperCase(),
        path: route.path,
      });
    }
  });
  return endpoints;
}

export function extractZodErrors(responseJson: any) {
  const errors: ValidationError[] = [];
  if (
    responseJson &&
    responseJson.success === false &&
    responseJson.error &&
    responseJson.error.name === "ZodError"
  ) {
    const zodError = responseJson.error as ZodError;
    zodError.issues?.forEach((zodIssue) => {
      errors.push({
        loc: zodIssue.path.join("."),
        msg: zodIssue.message,
        type: zodIssue.code,
      });
    });
  }
  return errors;
}
