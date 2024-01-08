import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request, Response } from "express";

import { ApitallyClient } from "../common/client.js";
import { KeyInfo } from "../common/keyRegistry.js";

export const Scopes = (...scopes: string[]) => SetMetadata("scopes", scopes);

@Injectable()
export class ApitallyApiKeyGuard implements CanActivate {
  public static customHeader?: string;

  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext) {
    const customHeader = ApitallyApiKeyGuard.customHeader;
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    let apiKey: string | undefined;

    if (!customHeader) {
      if (!req.headers.authorization) {
        res.set("WWW-Authenticate", "ApiKey");
        throw new UnauthorizedException("Missing authorization header");
      }
      const authorizationParts = req.headers.authorization.split(" ");
      if (
        authorizationParts.length === 2 &&
        authorizationParts[0].toLowerCase() === "apikey"
      ) {
        apiKey = authorizationParts[1];
      } else {
        res.set("WWW-Authenticate", "ApiKey");
        throw new UnauthorizedException("Invalid authorization scheme");
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
      throw new ForbiddenException("Missing API key");
    }

    const client = ApitallyClient.getInstance();
    const keyInfo = await client.keyRegistry.get(apiKey);
    if (!keyInfo) {
      throw new ForbiddenException("Invalid API key");
    }
    const scopes = this.reflector.get<string[]>("scopes", context.getHandler());
    if (scopes && !keyInfo.hasScopes(scopes)) {
      throw new ForbiddenException("Permission denied");
    }

    req.keyInfo = keyInfo;
    return true;
  }
}

export const GetKeyInfo = createParamDecorator<KeyInfo | undefined>(
  (data: unknown, context: ExecutionContext) => {
    const req = context.switchToHttp().getRequest<Request>();
    return req.keyInfo;
  },
);
