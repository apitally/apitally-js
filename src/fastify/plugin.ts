import { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { ApitallyClient } from "../common/client";
import { KeyInfo } from "../common/keyRegistry";
import { ApitallyConfig, PathInfo, ValidationError } from "../common/types";
import { getPackageVersion } from "../common/utils";

declare module "fastify" {
  interface FastifyReply {
    payload: any;
  }

  interface FastifyRequest {
    consumerIdentifier?: string;
    keyInfo?: KeyInfo;
  }
}

const apitallyPlugin = async (
  fastify: FastifyInstance,
  config: ApitallyConfig,
) => {
  const client = new ApitallyClient(config);
  const routes: PathInfo[] = [];

  fastify.decorateReply("payload", null);

  fastify.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    methods.forEach((method) => {
      routeOptions.onSend;
      if (method !== "HEAD") {
        routes.push({
          method: method,
          path: routeOptions.url,
        });
      }
    });
  });

  fastify.addHook("onReady", () => {
    client.setAppInfo(getAppInfo(routes, config.appVersion));
  });

  fastify.addHook("onSend", (request, reply, payload: any, done) => {
    try {
      reply.payload = JSON.parse(payload);
    } catch (error) {} // eslint-disable-line no-empty
    done();
  });

  fastify.addHook("onResponse", (request, reply, done) => {
    // Get path from routeOptions if available (from v4), otherwise fallback to deprecated routerPath
    const path =
      "routeOptions" in request
        ? (request as any).routeOptions.url
        : (request as any).routerPath;
    client.requestLogger.logRequest({
      consumer: getConsumer(request),
      method: request.method,
      path: path,
      statusCode: reply.statusCode,
      responseTime: reply.getResponseTime(),
    });
    if (
      (reply.statusCode === 400 || reply.statusCode === 422) &&
      reply.payload &&
      (!reply.payload.code || reply.payload.code === "FST_ERR_VALIDATION") &&
      typeof reply.payload.message === "string"
    ) {
      const validationErrors = extractAjvErrors(reply.payload.message);
      validationErrors.forEach((error) => {
        client.validationErrorLogger.logValidationError({
          consumer: getConsumer(request),
          method: request.method,
          path: path,
          ...error,
        });
      });
    }
    done();
  });
};

const getAppInfo = (routes: PathInfo[], appVersion?: string) => {
  const versions: Array<[string, string]> = [["nodejs", process.version]];
  const fastifyVersion = getPackageVersion("fastify");
  const apitallyVersion = getPackageVersion("../..");
  if (fastifyVersion) {
    versions.push(["fastify", fastifyVersion]);
  }
  if (apitallyVersion) {
    versions.push(["apitally", apitallyVersion]);
  }
  if (appVersion) {
    versions.push(["app", appVersion]);
  }
  return {
    paths: routes,
    versions: new Map(versions),
    client: "js:fastify",
  };
};

const getConsumer = (request: FastifyRequest) => {
  if (request.consumerIdentifier) {
    return String(request.consumerIdentifier);
  }
  if (request.keyInfo && request.keyInfo instanceof KeyInfo) {
    return `key:${request.keyInfo.keyId}`;
  }
  return null;
};

const extractAjvErrors = (message: string): ValidationError[] => {
  const regex =
    /(?<=^|, )((?:headers|params|query|querystring|body)[/.][^ ]+)(?= )/g;
  const matches: { match: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(message)) !== null) {
    matches.push({ match: match[0], index: match.index });
  }

  return matches.map((m, i) => {
    const endIndex =
      i + 1 < matches.length ? matches[i + 1].index - 2 : message.length;
    const matchSplit = m.match.split(/[/.]/);
    if (matchSplit[0] === "querystring") {
      matchSplit[0] = "query";
    }
    return {
      loc: matchSplit.join("."),
      msg: message.substring(m.index, endIndex),
      type: "",
    };
  });
};

export default fp(apitallyPlugin, {
  name: "apitally",
});
