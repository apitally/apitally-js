import { NextFunction, Request, Response } from "express";

import { ApitallyClient } from "../common/client";

export const requireApiKey = ({
  scopes,
  customHeader,
}: {
  scopes?: string | string[];
  customHeader?: string;
} = {}) => {
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
      const customHeaderValue = req.headers[customHeader.toLowerCase()];
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

    const client = ApitallyClient.getInstance();
    const keyInfo = await client.keyRegistry.get(apiKey);
    if (!keyInfo) {
      res.status(403).json({ error: "Invalid API key" });
      return;
    }
    if (scopes && !keyInfo.hasScopes(scopes)) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }

    req.keyInfo = keyInfo;
    next();
  };
};
