import type { Express, NextFunction, Request, Response } from "express";
import { performance } from "perf_hooks";

import { ApitallyClient } from "../common/client.js";
import { KeyInfo } from "../common/keyRegistry.js";
import { getPackageVersion } from "../common/packageVersions.js";
import { ApitallyConfig, AppInfo, ValidationError } from "../common/types.js";
import listEndpoints from "./listEndpoints.js";

declare module "express" {
  interface Request {
    consumerIdentifier?: string;
    keyInfo?: KeyInfo;
  }
}

export const useApitally = (app: Express, config: ApitallyConfig) => {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(client);
  app.use(middleware);
  setTimeout(() => {
    client.setAppInfo(getAppInfo(app, config.appVersion));
  }, 100);
};

const getMiddleware = (client: ApitallyClient) => {
  const validatorInstalled = getPackageVersion("express-validator") !== null;
  const celebrateInstalled = getPackageVersion("celebrate") !== null;
  const nestInstalled = getPackageVersion("@nestjs/core") !== null;
  const classValidatorInstalled = getPackageVersion("class-validator") !== null;

  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const startTime = performance.now();
      const originalJson = res.json;
      res.json = (body) => {
        res.locals.body = body;
        return originalJson.call(res, body);
      };
      res.on("finish", () => {
        try {
          if (req.route) {
            const responseTime = performance.now() - startTime;
            client.requestCounter.addRequest({
              consumer: getConsumer(req),
              method: req.method,
              path: req.route.path,
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
                  consumer: getConsumer(req),
                  method: req.method,
                  path: req.route.path,
                  ...error,
                });
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

const getConsumer = (req: Request) => {
  if (req.consumerIdentifier) {
    return String(req.consumerIdentifier);
  }
  if (req.keyInfo && req.keyInfo instanceof KeyInfo) {
    return `key:${req.keyInfo.keyId}`;
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

const getAppInfo = (app: Express, appVersion?: string): AppInfo => {
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
    paths: listEndpoints(app),
    versions: Object.fromEntries(versions),
    client: "js:express",
  };
};
