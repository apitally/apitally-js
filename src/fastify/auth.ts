import type {
  DoneFuncWithErrOrRes,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { ApitallyClient } from "../common/client.js";

export const requireApiKey = ({
  scopes,
  customHeader,
}: {
  scopes?: string | string[];
  customHeader?: string;
} = {}) => {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
    done: DoneFuncWithErrOrRes,
  ) => {
    let apiKey: string | undefined;

    if (!customHeader) {
      if (!request.headers.authorization) {
        reply
          .code(401)
          .header("WWW-Authenticate", "ApiKey")
          .send({ error: "Missing authorization header" });
        return;
      }
      const authorizationParts = request.headers.authorization.split(" ");
      if (
        authorizationParts.length === 2 &&
        authorizationParts[0].toLowerCase() === "apikey"
      ) {
        apiKey = authorizationParts[1];
      } else {
        reply
          .code(401)
          .header("WWW-Authenticate", "ApiKey")
          .send({ error: "Invalid authorization scheme" });
        return;
      }
    } else if (customHeader) {
      const customHeaderValue = request.headers[customHeader.toLowerCase()];
      if (typeof customHeaderValue === "string") {
        apiKey = customHeaderValue;
      } else if (Array.isArray(customHeaderValue)) {
        apiKey = customHeaderValue[0];
      }
    }

    if (!apiKey) {
      reply.code(403).send({ error: "Missing API key" });
      return;
    }

    const client = ApitallyClient.getInstance();
    const keyInfo = await client.keyRegistry.get(apiKey);
    if (!keyInfo) {
      reply.code(403).send({ error: "Invalid API key" });
      return;
    }
    if (scopes && !keyInfo.hasScopes(scopes)) {
      reply.code(403).send({ error: "Permission denied" });
      return;
    }

    request.keyInfo = keyInfo;
    done();
  };
};
