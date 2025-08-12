import { AsyncLocalStorage } from "async_hooks";
import Koa from "koa";

import { ApitallyClient } from "../common/client.js";
import { patchConsole } from "../common/console.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { getPackageVersion } from "../common/packageVersions.js";
import {
  convertBody,
  convertHeaders,
  LogRecord,
} from "../common/requestLogger.js";
import {
  ApitallyConfig,
  ApitallyConsumer,
  PathInfo,
  StartupData,
} from "../common/types.js";
import { patchWinston } from "../common/winston.js";

export function useApitally(app: Koa, config: ApitallyConfig) {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(client);
  app.use(middleware);

  const setStartupData = (attempt: number = 1) => {
    const appInfo = getAppInfo(app, config.appVersion);
    if (appInfo.paths.length > 0 || attempt >= 10) {
      client.setStartupData(appInfo);
    } else {
      setTimeout(() => setStartupData(attempt + 1), 500);
    }
  };
  setTimeout(() => setStartupData(), 500);
}

function getMiddleware(client: ApitallyClient) {
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

  if (client.requestLogger.config.captureLogs) {
    patchConsole(logsContext);
    patchWinston(logsContext);
  }

  return async (ctx: Koa.Context, next: Koa.Next) => {
    if (!client.isEnabled() || ctx.request.method.toUpperCase() === "OPTIONS") {
      await next();
      return;
    }

    await logsContext.run([], async () => {
      let path: string | undefined;
      let statusCode: number | undefined;
      let serverError: Error | undefined;
      const startTime = performance.now();
      try {
        await next();
      } catch (error: any) {
        path = getPath(ctx);
        statusCode = error.statusCode || error.status || 500;
        if (path && statusCode === 500 && error instanceof Error) {
          serverError = error;
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
        const responseTime = performance.now() - startTime;
        const consumer = getConsumer(ctx);
        client.consumerRegistry.addOrUpdateConsumer(consumer);
        if (!path) {
          path = getPath(ctx);
        }
        if (path) {
          try {
            client.requestCounter.addRequest({
              consumer: consumer?.identifier,
              method: ctx.request.method,
              path,
              statusCode: statusCode || ctx.response.status,
              responseTime,
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
        if (client.requestLogger.enabled) {
          const logs = logsContext.getStore();
          client.requestLogger.logRequest(
            {
              timestamp: Date.now() / 1000,
              method: ctx.request.method,
              path,
              url: ctx.request.href,
              headers: convertHeaders(ctx.request.headers),
              size: ctx.request.length,
              consumer: consumer?.identifier,
              body: convertBody(
                ctx.request.body,
                ctx.request.get("content-type"),
              ),
            },
            {
              statusCode: statusCode || ctx.response.status,
              responseTime: responseTime / 1000,
              headers: convertHeaders(ctx.response.headers),
              size: ctx.response.length,
              body: convertBody(
                ctx.response.body,
                ctx.response.get("content-type"),
              ),
            },
            serverError,
            logs,
          );
        }
      }
    });
  };
}

function getPath(ctx: Koa.Context) {
  return ctx._matchedRoute || ctx.routePath; // _matchedRoute is set by koa-router, routePath is set by koa-route
}

export function setConsumer(
  ctx: Koa.Context,
  consumer: ApitallyConsumer | string | null | undefined,
) {
  ctx.state.apitallyConsumer = consumer || undefined;
}

function getConsumer(ctx: Koa.Context) {
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
}

function getAppInfo(app: Koa, appVersion?: string): StartupData {
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
}

function isKoaRouterMiddleware(middleware: any) {
  return (
    typeof middleware === "function" &&
    middleware.router &&
    Array.isArray(middleware.router.stack)
  );
}

function listEndpoints(app: Koa) {
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
}
