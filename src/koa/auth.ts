import Koa from "koa";

import { ApitallyClient } from "../common/client";

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
