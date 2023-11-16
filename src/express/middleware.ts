import { Express, NextFunction, Request, Response } from "express";
import { performance } from "perf_hooks";

import { ApitallyClient } from "../common/client";
import { KeyInfo } from "../common/keyRegistry";
import { ApitallyConfig, AppInfo, ValidationError } from "../common/types";
import { getPackageVersion } from "../common/utils";
import listEndpoints from "./listEndpoints";

export const useApitally = (app: Express, config: ApitallyConfig) => {
  const client = new ApitallyClient(config);
  const middleware = getMiddleware(client);
  app.use(middleware);
  setTimeout(() => {
    client.setAppInfo(getAppInfo(app, config.appVersion));
  }, 1000);
};

export const requireApiKey = (scopes: string[] = [], customHeader?: string) => {
  const client = ApitallyClient.getInstance();
  return async (req: Request, res: Response, next: NextFunction) => {
    let apiKey: string | undefined;

    if (!customHeader) {
      if (!req.headers.authorization) {
        res
          .status(401)
          .set("WWW-Authenticate", "ApiKey")
          .json({ error: "Missing authorization header" });
        return;
      }
      const authorizationParts = req.headers.authorization.split(" ");
      if (
        authorizationParts.length === 2 &&
        authorizationParts[0].toLowerCase() === "apikey"
      ) {
        apiKey = authorizationParts[1];
      } else {
        res
          .status(401)
          .set("WWW-Authenticate", "ApiKey")
          .json({ error: "Invalid authorization scheme" });
        return;
      }
    } else if (customHeader) {
      const customHeaderValue = req.headers[customHeader];
      if (typeof customHeaderValue === "string") {
        apiKey = customHeaderValue;
      } else if (Array.isArray(customHeaderValue)) {
        apiKey = customHeaderValue[0];
      }
    }

    if (!apiKey) {
      res.status(403).json({ error: "Missing API key" });
      return;
    }

    const keyInfo = await client.keyRegistry.get(apiKey);
    if (!keyInfo) {
      res.status(403).json({ error: "Invalid API key" });
      return;
    }
    if (!keyInfo.hasScopes(scopes)) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    res.locals.keyInfo = keyInfo;
    next();
  };
};

const getMiddleware = (client: ApitallyClient) => {
  const expressValidatorInstalled =
    getPackageVersion("express-validator") !== null;
  const celebrateInstalled = getPackageVersion("celebrate") !== null;

  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const startTime = performance.now();
      const originalJson = res.json;
      res.json = (body) => {
        res.locals.body = body;
        return originalJson.call(res, body);
      };
      res.on("finish", () => {
        if (req.route) {
          client.requestLogger.logRequest({
            consumer: getConsumer(res),
            method: req.method,
            path: req.route.path,
            statusCode: res.statusCode,
            responseTime: performance.now() - startTime,
          });
          if (res.statusCode === 400 || res.statusCode === 422) {
            try {
              if (res.locals.body) {
                let validationErrors: ValidationError[] = [];
                if (expressValidatorInstalled) {
                  validationErrors.push(
                    ...extractExpressValidatorErrors(res.locals.body)
                  );
                }
                if (celebrateInstalled) {
                  validationErrors.push(
                    ...extractCelebrateErrors(res.locals.body)
                  );
                }
                validationErrors.forEach((error: any) => {
                  client.validationErrorLogger.logValidationError({
                    consumer: getConsumer(res),
                    method: req.method,
                    path: req.route.path,
                    ...error,
                  });
                });
              }
            } catch (error) {}
          }
        }
      });
    } catch (error) {
      client.logger.error(
        "Error while handling request in Apitally middleware.",
        { request: req, response: res, error }
      );
    } finally {
      next();
    }
  };
};

const getConsumer = (res: Response) => {
  if (res.locals.consumerIdentifier) {
    return String(res.locals.consumerIdentifier);
  }
  if (res.locals.keyInfo && res.locals.keyInfo instanceof KeyInfo) {
    return `key:${res.locals.keyInfo.keyId}`;
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

const subsetJoiMessage = (message: string, key: string) => {
  const messageWithKey = message
    .split(". ")
    .find((message) => message.includes(`"${key}"`));
  return messageWithKey ? messageWithKey : message;
};

const getAppInfo = (app: Express, appVersion?: string): AppInfo => {
  const versions: Array<[string, string]> = [["nodejs", process.version]];
  const expressVersion = getPackageVersion("express");
  const apitallyVersion = getPackageVersion(".");
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
    versions: new Map(versions),
    client: "js:express",
  };
};
