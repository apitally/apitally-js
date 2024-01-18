import Koa from "koa";

import { ApitallyClient } from "../common/client.js";
import { KeyInfo } from "../common/keyRegistry.js";
import { getPackageVersion } from "../common/packageVersions.js";
import { ApitallyConfig, AppInfo, PathInfo } from "../common/types.js";

export const useApitally = (app: Koa, config: ApitallyConfig) => {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(client);
  app.use(middleware);
  setTimeout(() => {
    client.setAppInfo(getAppInfo(app, config.appVersion));
  }, 100);
};

const getMiddleware = (client: ApitallyClient) => {
  return async (ctx: Koa.Context, next: Koa.Next) => {
    const startTime = performance.now();
    let statusCode: number | undefined;
    try {
      await next();
    } catch (error: any) {
      statusCode = error.statusCode || error.status || 500;
      throw error;
    } finally {
      try {
        // _matchedRoute is set by koa-router, routePath is set by koa-route
        if (ctx._matchedRoute || ctx.routePath) {
          client.requestLogger.logRequest({
            consumer: getConsumer(ctx),
            method: ctx.request.method,
            path: ctx._matchedRoute || ctx.routePath,
            statusCode: statusCode || ctx.response.status,
            responseTime: performance.now() - startTime,
          });
        }
      } catch (error) {
        client.logger.error(
          "Error while logging request in Apitally middleware.",
          { context: ctx, error },
        );
      }
    }
  };
};

const getConsumer = (ctx: Koa.Context) => {
  if (ctx.state.consumerIdentifier) {
    return String(ctx.state.consumerIdentifier);
  }
  if (ctx.state.keyInfo && ctx.state.keyInfo instanceof KeyInfo) {
    return `key:${ctx.state.keyInfo.keyId}`;
  }
  return null;
};

const getAppInfo = (app: Koa, appVersion?: string): AppInfo => {
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
