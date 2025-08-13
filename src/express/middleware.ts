import { AsyncLocalStorage } from "async_hooks";
import type { Express, NextFunction, Request, Response, Router } from "express";
import { performance } from "perf_hooks";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { parseContentLength } from "../common/headers.js";
import { getPackageVersion } from "../common/packageVersions.js";
import {
  convertBody,
  convertHeaders,
  LogRecord,
} from "../common/requestLogger.js";
import {
  ApitallyConfig,
  ApitallyConsumer,
  StartupData,
  ValidationError,
} from "../common/types.js";
import {
  patchConsole,
  patchNestLogger,
  patchPinoLogger,
  patchWinston,
} from "../loggers/index.js";
import {
  getEndpoints,
  getRouterInfo,
  parseExpressPath,
  parseExpressPathRegExp,
} from "./utils.js";

declare module "express" {
  interface Request {
    apitallyConsumer?: ApitallyConsumer | string | null;
    consumerIdentifier?: ApitallyConsumer | string | null; // For backwards compatibility
  }
}

export function useApitally(
  app: Express | Router,
  config: ApitallyConfig & { basePath?: string },
) {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(app, client);
  app.use(middleware);

  const setStartupData = (attempt: number = 1) => {
    const appInfo = getAppInfo(app, config.basePath, config.appVersion);
    if (appInfo.paths.length > 0 || attempt >= 10) {
      client.setStartupData(appInfo);
    } else {
      setTimeout(() => setStartupData(attempt + 1), 500);
    }
  };
  setTimeout(() => setStartupData(), 500);
}

function getMiddleware(app: Express | Router, client: ApitallyClient) {
  let errorHandlerConfigured = false;
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

  if (client.requestLogger.config.captureLogs) {
    patchConsole(logsContext);
    patchWinston(logsContext);
    patchNestLogger(logsContext);
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!client.isEnabled() || req.method.toUpperCase() === "OPTIONS") {
      next();
      return;
    }

    if (!errorHandlerConfigured) {
      // Add error handling middleware to the bottom of the stack when handling the first request
      app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
        res.locals.serverError = err;
        next(err);
      });
      errorHandlerConfigured = true;
    }

    if (client.requestLogger.config.captureLogs && req.log) {
      await patchPinoLogger(req.log, logsContext);
    }

    logsContext.run([], () => {
      try {
        const startTime = performance.now();
        const originalSend = res.send;
        res.send = (body) => {
          const contentType = res.get("content-type");
          if (client.requestLogger.isSupportedContentType(contentType)) {
            res.locals.body = body;
          }
          return originalSend.call(res, body);
        };

        res.once("finish", () => {
          try {
            const responseTime = performance.now() - startTime;
            const path = getRoutePath(req);
            const consumer = getConsumer(req);
            client.consumerRegistry.addOrUpdateConsumer(consumer);

            const requestSize = parseContentLength(req.get("content-length"));
            const responseSize = parseContentLength(res.get("content-length"));

            if (path) {
              client.requestCounter.addRequest({
                consumer: consumer?.identifier,
                method: req.method,
                path,
                statusCode: res.statusCode,
                responseTime: responseTime,
                requestSize,
                responseSize,
              });

              if (
                (res.statusCode === 400 || res.statusCode === 422) &&
                res.locals.body
              ) {
                let jsonBody: any;
                try {
                  jsonBody = JSON.parse(res.locals.body);
                } catch {
                  // Ignore
                }
                if (jsonBody) {
                  const validationErrors: ValidationError[] = [];
                  if (validationErrors.length === 0) {
                    validationErrors.push(
                      ...extractExpressValidatorErrors(jsonBody),
                    );
                  }
                  if (validationErrors.length === 0) {
                    validationErrors.push(...extractCelebrateErrors(jsonBody));
                  }
                  if (validationErrors.length === 0) {
                    validationErrors.push(
                      ...extractNestValidationErrors(jsonBody),
                    );
                  }
                  validationErrors.forEach((error) => {
                    client.validationErrorCounter.addValidationError({
                      consumer: consumer?.identifier,
                      method: req.method,
                      path: req.route.path,
                      ...error,
                    });
                  });
                }
              }

              if (res.statusCode === 500 && res.locals.serverError) {
                const serverError = res.locals.serverError as Error;
                client.serverErrorCounter.addServerError({
                  consumer: consumer?.identifier,
                  method: req.method,
                  path: req.route.path,
                  type: serverError.name,
                  msg: serverError.message,
                  traceback: serverError.stack || "",
                });
              }
            }

            if (client.requestLogger.enabled) {
              const logs = logsContext.getStore();
              client.requestLogger.logRequest(
                {
                  timestamp: Date.now() / 1000,
                  method: req.method,
                  path,
                  url: `${req.protocol}://${req.host}${req.originalUrl}`,
                  headers: convertHeaders(req.headers),
                  size: requestSize,
                  consumer: consumer?.identifier,
                  body: convertBody(req.body, req.get("content-type")),
                },
                {
                  statusCode: res.statusCode,
                  responseTime: responseTime / 1000,
                  headers: convertHeaders(res.getHeaders()),
                  size: responseSize,
                  body: convertBody(res.locals.body, res.get("content-type")),
                },
                res.locals.serverError,
                logs,
              );
            }
          } catch (error) {
            client.logger.error(
              "Error while logging request in Apitally middleware.",
              { request: req, response: res, error },
            );
          }
        });
      } catch (error) {
        client.logger.error("Error in Apitally middleware.", {
          request: req,
          response: res,
          error,
        });
      } finally {
        next();
      }
    });
  };
}

function getRoutePath(req: Request) {
  if (!req.route) {
    return;
  }
  if (req.baseUrl) {
    const routerInfo = getRouterInfo(req.app);
    if (routerInfo.stack) {
      const routerPath = getRouterPath(routerInfo.stack, req.baseUrl);
      return req.route.path === "/" ? routerPath : routerPath + req.route.path;
    }
  }
  return req.route.path;
}

function getRouterPath(stack: any[], baseUrl: string) {
  const routerPaths: string[] = [];
  while (stack && stack.length > 0) {
    const routerLayer = stack.find(
      (layer) =>
        layer.name === "router" &&
        layer.path &&
        (baseUrl.startsWith(layer.path) || layer.regexp?.test(baseUrl)),
    );
    if (routerLayer) {
      if (
        routerLayer.regexp &&
        routerLayer.keys &&
        routerLayer.keys.length > 0
      ) {
        const parsedPath = parseExpressPathRegExp(
          routerLayer.regexp,
          routerLayer.keys,
        );
        routerPaths.push("/" + parsedPath);
      } else if (
        routerLayer.params &&
        Object.keys(routerLayer.params).length > 0
      ) {
        const parsedPath = parseExpressPath(
          routerLayer.path,
          routerLayer.params,
        );
        routerPaths.push(parsedPath);
      } else {
        routerPaths.push(routerLayer.path);
      }
      stack = routerLayer.handle?.stack;
      baseUrl = baseUrl.slice(routerLayer.path.length);
    } else {
      break;
    }
  }
  return routerPaths.filter((path) => path !== "/").join("");
}

export function setConsumer(
  req: Request,
  consumer: ApitallyConsumer | string | null | undefined,
) {
  req.apitallyConsumer = consumer || undefined;
}

function getConsumer(req: Request) {
  if (req.apitallyConsumer) {
    return consumerFromStringOrObject(req.apitallyConsumer);
  } else if (req.consumerIdentifier) {
    // For backwards compatibility
    process.emitWarning(
      "The consumerIdentifier property on the request object is deprecated. Use apitallyConsumer instead.",
      "DeprecationWarning",
    );
    return consumerFromStringOrObject(req.consumerIdentifier);
  }
  return null;
}

function extractExpressValidatorErrors(responseBody: any) {
  try {
    const errors: ValidationError[] = [];
    if (
      responseBody &&
      responseBody.errors &&
      Array.isArray(responseBody.errors)
    ) {
      responseBody.errors.forEach((error: any) => {
        if (error.location && error.path && error.msg && error.type) {
          errors.push({
            loc: `${error.location}.${error.path}`,
            msg: error.msg,
            type: error.type,
          });
        }
      });
    }
    return errors;
  } catch (error) {
    return [];
  }
}

function extractCelebrateErrors(responseBody: any) {
  try {
    const errors: ValidationError[] = [];
    if (responseBody && responseBody.validation) {
      Object.values(responseBody.validation).forEach((error: any) => {
        if (
          error.source &&
          error.keys &&
          Array.isArray(error.keys) &&
          error.message
        ) {
          error.keys.forEach((key: string) => {
            errors.push({
              loc: `${error.source}.${key}`,
              msg: subsetJoiMessage(error.message, key),
              type: "",
            });
          });
        }
      });
    }
    return errors;
  } catch (error) {
    return [];
  }
}

function extractNestValidationErrors(responseBody: any) {
  try {
    const errors: ValidationError[] = [];
    if (responseBody && Array.isArray(responseBody.message)) {
      responseBody.message.forEach((message: any) => {
        errors.push({
          loc: "",
          msg: message,
          type: "",
        });
      });
    }
    return errors;
  } catch (error) {
    return [];
  }
}

function subsetJoiMessage(message: string, key: string) {
  const messageWithKey = message
    .split(". ")
    .find((message) => message.includes(`"${key}"`));
  return messageWithKey ? messageWithKey : message;
}

function getAppInfo(
  app: Express | Router,
  basePath?: string,
  appVersion?: string,
): StartupData {
  const versions: Array<[string, string]> = [
    ["nodejs", process.version.replace(/^v/, "")],
  ];
  const expressVersion = getPackageVersion("express");
  const nestjsVersion = getPackageVersion("@nestjs/core");
  const apitallyVersion = getPackageVersion("../..");
  if (expressVersion) {
    versions.push(["express", expressVersion]);
  }
  if (nestjsVersion) {
    versions.push(["nestjs", nestjsVersion]);
  }
  if (apitallyVersion) {
    versions.push(["apitally", apitallyVersion]);
  }
  if (appVersion) {
    versions.push(["app", appVersion]);
  }
  return {
    paths: getEndpoints(app, basePath || ""),
    versions: Object.fromEntries(versions),
    client: "js:express",
  };
}
