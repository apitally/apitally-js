import Koa from "koa";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { getPackageVersion } from "../common/packageVersions.js";
import { ApitallyConfig, PathInfo, StartupData } from "../common/types.js";

export const useApitally = (app: Koa, config: ApitallyConfig) => {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(client);
  app.use(middleware);
  setTimeout(() => {
    client.setStartupData(getAppInfo(app, config.appVersion));
  }, 1000);
};

const getMiddleware = (client: ApitallyClient) => {
  return async (ctx: Koa.Context, next: Koa.Next) => {
    let path: string | undefined;
    let statusCode: number | undefined;
    const startTime = performance.now();
    try {
      await next();
    } catch (error: any) {
      path = getPath(ctx);
      statusCode = error.statusCode || error.status || 500;
      if (path && statusCode === 500 && error instanceof Error) {
        client.serverErrorCounter.addServerError({
          consumer: getConsumer(ctx)?.identifier,
          method: ctx.request.method,
          path,
          type: error.name,
          msg: error.message,
          traceback: error.stack || "",
        });
      }
      throw error;
    } finally {
      if (!path) {
        path = getPath(ctx);
      }
      if (path) {
        try {
          const consumer = getConsumer(ctx);
          client.consumerRegistry.addOrUpdateConsumer(consumer);
          client.requestCounter.addRequest({
            consumer: consumer?.identifier,
            method: ctx.request.method,
            path,
            statusCode: statusCode || ctx.response.status,
            responseTime: performance.now() - startTime,
            requestSize: ctx.request.length,
            responseSize: ctx.response.length,
          });
        } catch (error) {
          client.logger.error(
            "Error while logging request in Apitally middleware.",
            { context: ctx, error },
          );
        }
      }
    }
  };
};

const getPath = (ctx: Koa.Context) => {
  return ctx._matchedRoute || ctx.routePath; // _matchedRoute is set by koa-router, routePath is set by koa-route
};

const getConsumer = (ctx: Koa.Context) => {
  if (ctx.state.apitallyConsumer) {
    return consumerFromStringOrObject(ctx.state.apitallyConsumer);
  } else if (ctx.state.consumerIdentifier) {
    // For backwards compatibility
    process.emitWarning(
      "The consumerIdentifier property on the ctx.state object is deprecated. Use apitallyConsumer instead.",
      "DeprecationWarning",
    );
    return consumerFromStringOrObject(ctx.state.consumerIdentifier);
  }
  return null;
};

const getAppInfo = (app: Koa, appVersion?: string): StartupData => {
  const versions: Array<[string, string]> = [
    ["nodejs", process.version.replace(/^v/, "")],
  ];
  const koaVersion = getPackageVersion("koa");
  const apitallyVersion = getPackageVersion("../..");
  if (koaVersion) {
    versions.push(["koa", koaVersion]);
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
    client: "js:koa",
  };
};

const isKoaRouterMiddleware = (middleware: any) => {
  return (
    typeof middleware === "function" &&
    middleware.router &&
    Array.isArray(middleware.router.stack)
  );
};

const listEndpoints = (app: Koa) => {
  const endpoints: Array<PathInfo> = [];
  app.middleware.forEach((middleware: any) => {
    if (isKoaRouterMiddleware(middleware)) {
      middleware.router.stack.forEach((layer: any) => {
        if (layer.methods && layer.methods.length > 0) {
          layer.methods.forEach((method: string) => {
            if (!["HEAD", "OPTIONS"].includes(method.toUpperCase())) {
              endpoints.push({
                method: method.toUpperCase(),
                path: layer.path,
              });
            }
          });
        }
      });
    }
  });
  return endpoints;
};
