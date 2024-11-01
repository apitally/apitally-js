import type { Express, NextFunction, Request, Response, Router } from "express";
import { performance } from "perf_hooks";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { getPackageVersion } from "../common/packageVersions.js";
import {
  ApitallyConfig,
  ApitallyConsumer,
  StartupData,
  ValidationError,
} from "../common/types.js";
import { getEndpoints, parseExpressPath } from "./utils.js";

declare module "express" {
  interface Request {
    apitallyConsumer?: ApitallyConsumer | string | null;
    consumerIdentifier?: ApitallyConsumer | string | null; // For backwards compatibility
  }
}

export const useApitally = (
  app: Express | Router,
  config: ApitallyConfig & { basePath?: string },
) => {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(app, client);
  app.use(middleware);
  setTimeout(() => {
    client.setStartupData(getAppInfo(app, config.basePath, config.appVersion));
  }, 1000);
};

const getMiddleware = (app: Express | Router, client: ApitallyClient) => {
  const validatorInstalled = getPackageVersion("express-validator") !== null;
  const celebrateInstalled = getPackageVersion("celebrate") !== null;
  const nestInstalled = getPackageVersion("@nestjs/core") !== null;
  const classValidatorInstalled = getPackageVersion("class-validator") !== null;
  let errorHandlerConfigured = false;

  return (req: Request, res: Response, next: NextFunction) => {
    if (!errorHandlerConfigured) {
      // Add error handling middleware to the bottom of the stack when handling the first request
      app.use(
        (err: Error, req: Request, res: Response, next: NextFunction): void => {
          res.locals.serverError = err;
          next(err);
        },
      );
      errorHandlerConfigured = true;
    }
    try {
      const startTime = performance.now();
      const originalJson = res.json;
      res.json = (body) => {
        res.locals.body = body;
        return originalJson.call(res, body);
      };
      res.on("finish", () => {
        try {
          const path = getRoutePath(req);
          if (path) {
            const responseTime = performance.now() - startTime;
            const consumer = getConsumer(req);
            client.consumerRegistry.addOrUpdateConsumer(consumer);
            client.requestCounter.addRequest({
              consumer: consumer?.identifier,
              method: req.method,
              path,
              statusCode: res.statusCode,
              responseTime: responseTime,
              requestSize: req.get("content-length"),
              responseSize: res.get("content-length"),
            });
            if (
              (res.statusCode === 400 || res.statusCode === 422) &&
              res.locals.body
            ) {
              const validationErrors: ValidationError[] = [];
              if (validatorInstalled) {
                validationErrors.push(
                  ...extractExpressValidatorErrors(res.locals.body),
                );
              }
              if (celebrateInstalled) {
                validationErrors.push(
                  ...extractCelebrateErrors(res.locals.body),
                );
              }
              if (nestInstalled && classValidatorInstalled) {
                validationErrors.push(
                  ...extractNestValidationErrors(res.locals.body),
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
  };
};

const getRoutePath = (req: Request) => {
  if (!req.route) {
    return;
  }
  if (req.baseUrl) {
    const routerPaths = getRouterPaths(req.app._router.stack, req.baseUrl);
    return routerPaths.join("") + req.route.path;
  }
  return req.route.path;
};

const getRouterPaths = (stack: any[], baseUrl: string) => {
  const routerPaths: string[] = [];
  while (stack && stack.length > 0) {
    const routerLayer = stack.find(
      (layer) => layer.name === "router" && layer.regexp?.test(baseUrl),
    );
    if (routerLayer) {
      if (routerLayer.keys.length > 0) {
        const parsedPath = parseExpressPath(
          routerLayer.regexp,
          routerLayer.keys,
        );
        routerPaths.push("/" + parsedPath);
      } else {
        routerPaths.push(routerLayer.path);
      }
      stack = routerLayer.handle?.stack;
      baseUrl = baseUrl.slice(routerLayer.path.length);
    } else {
      break;
    }
  }
  return routerPaths;
};

const getConsumer = (req: Request) => {
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
};

const extractExpressValidatorErrors = (responseBody: any) => {
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
};

const extractCelebrateErrors = (responseBody: any) => {
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
};

const extractNestValidationErrors = (responseBody: any) => {
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
};

const subsetJoiMessage = (message: string, key: string) => {
  const messageWithKey = message
    .split(". ")
    .find((message) => message.includes(`"${key}"`));
  return messageWithKey ? messageWithKey : message;
};

const getAppInfo = (
  app: Express | Router,
  basePath?: string,
  appVersion?: string,
): StartupData => {
  const versions: Array<[string, string]> = [
    ["nodejs", process.version.replace(/^v/, "")],
  ];
  const expressVersion = getPackageVersion("express");
  const apitallyVersion = getPackageVersion("../..");
  if (expressVersion) {
    versions.push(["express", expressVersion]);
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
};
