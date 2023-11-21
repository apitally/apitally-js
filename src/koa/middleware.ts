import Koa from "koa";

import { ApitallyClient } from "../common/client";
import { KeyInfo } from "../common/keyRegistry";
import { ApitallyConfig, AppInfo, PathInfo } from "../common/types";
import { getPackageVersion } from "../common/utils";

export const useApitally = (app: Koa, config: ApitallyConfig) => {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(client);
  app.use(middleware);
  setTimeout(() => {
    client.setAppInfo(getAppInfo(app, config.appVersion));
  }, 100);
};

export const requireApiKey = ({
  scopes,
  customHeader,
}: {
  scopes?: string | string[];
  customHeader?: string;
} = {}) => {
  return async (ctx: Koa.Context, next: Koa.Next) => {
    let apiKey: string | undefined;

    if (!customHeader) {
      if (!ctx.headers.authorization) {
        ctx.status = 401;
        ctx.set("WWW-Authenticate", "ApiKey");
        ctx.body = { error: "Missing authorization header" };
        return;
      }
      const authorizationParts = ctx.headers.authorization.split(" ");
      if (
        authorizationParts.length === 2 &&
        authorizationParts[0].toLowerCase() === "apikey"
      ) {
        apiKey = authorizationParts[1];
      } else {
        ctx.status = 401;
        ctx.set("WWW-Authenticate", "ApiKey");
        ctx.body = { error: "Invalid authorization scheme" };
        return;
      }
    } else if (customHeader) {
      const customHeaderValue = ctx.headers[customHeader.toLowerCase()];
      if (typeof customHeaderValue === "string") {
        apiKey = customHeaderValue;
      } else if (Array.isArray(customHeaderValue)) {
        apiKey = customHeaderValue[0];
      }
    }

    if (!apiKey) {
      ctx.status = 403;
      ctx.body = { error: "Missing API key" };
      return;
    }

    const client = ApitallyClient.getInstance();
    const keyInfo = await client.keyRegistry.get(apiKey);
    if (!keyInfo) {
      ctx.status = 403;
      ctx.body = { error: "Invalid API key" };
      return;
    }
    if (scopes && !keyInfo.hasScopes(scopes)) {
      ctx.status = 403;
      ctx.body = { error: "Permission denied" };
      return;
    }

    ctx.state.keyInfo = keyInfo;
    await next();
  };
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
  const versions: Array<[string, string]> = [["nodejs", process.version]];
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
    versions: new Map(versions),
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
            if (method.toUpperCase() !== "HEAD") {
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
