import { Context, Hono } from "hono";
import { MiddlewareHandler } from "hono/types";
import { performance } from "perf_hooks";

import { isMiddleware } from "hono/utils/handler";
import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { getPackageVersion } from "../common/packageVersions.js";
import {
  ApitallyConfig,
  ApitallyConsumer,
  PathInfo,
  StartupData,
} from "../common/types.js";

declare module "hono" {
  interface ContextVariableMap {
    apitallyConsumer?: ApitallyConsumer | string;
  }
}

export const useApitally = (app: Hono, config: ApitallyConfig) => {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(client);
  app.use(middleware);
  setTimeout(() => {
    client.setStartupData(getAppInfo(app, config.appVersion));
  }, 1000);
};

const getMiddleware = (client: ApitallyClient): MiddlewareHandler => {
  return async (c, next) => {
    const startTime = performance.now();
    await next();
    const responseTime = performance.now() - startTime;
    const consumer = getConsumer(c);
    client.consumerRegistry.addOrUpdateConsumer(consumer);
    client.requestCounter.addRequest({
      consumer: consumer?.identifier,
      method: c.req.method,
      path: c.req.path,
      statusCode: c.res.status,
      responseTime,
      requestSize: c.req.header("Content-Length"),
      responseSize: undefined,
    });
    if (c.error) {
      client.serverErrorCounter.addServerError({
        consumer: consumer?.identifier,
        method: c.req.method,
        path: c.req.path,
        type: c.error.name,
        msg: c.error.message,
        traceback: c.error.stack || "",
      });
    }
  };
};

const getConsumer = (c: Context) => {
  const consumer = c.get("apitallyConsumer");
  if (consumer) {
    return consumerFromStringOrObject(consumer);
  }
  return null;
};

const getAppInfo = (app: Hono, appVersion?: string): StartupData => {
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
};

const listEndpoints = (app: Hono) => {
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
};
