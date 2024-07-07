import type {
  FastifyError,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import fp from "fastify-plugin";

import { ApitallyClient } from "../common/client.js";
import { consumerFromStringOrObject } from "../common/consumerRegistry.js";
import { getPackageVersion } from "../common/packageVersions.js";
import {
  ApitallyConfig,
  ApitallyConsumer,
  PathInfo,
  ValidationError,
} from "../common/types.js";

declare module "fastify" {
  interface FastifyReply {
    payload: any;
    serverError?: FastifyError;
  }

  interface FastifyRequest {
    apitallyConsumer?: ApitallyConsumer | string | null;
    consumerIdentifier?: ApitallyConsumer | string | null; // For backwards compatibility
  }
}

const apitallyPlugin: FastifyPluginAsync<ApitallyConfig> = async (
  fastify,
  config,
) => {
  const client = new ApitallyClient(config);
  const routes: PathInfo[] = [];

  fastify.decorateRequest("apitallyConsumer", null);
  fastify.decorateRequest("consumerIdentifier", null); // For backwards compatibility
  fastify.decorateReply("payload", null);

  fastify.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    methods.forEach((method) => {
      if (!["HEAD", "OPTIONS"].includes(method.toUpperCase())) {
        routes.push({
          method: method.toUpperCase(),
          path: routeOptions.url,
        });
      }
    });
  });

  fastify.addHook("onReady", () => {
    client.setStartupData(getAppInfo(routes, config.appVersion));
  });

  fastify.addHook("onClose", async () => {
    await client.handleShutdown();
  });

  fastify.addHook("onSend", (request, reply, payload: any, done) => {
    try {
      reply.payload = JSON.parse(payload);
    } catch (error) {} // eslint-disable-line no-empty
    done();
  });

  fastify.addHook("onError", (request, reply, error, done) => {
    if (!error.statusCode || error.statusCode === 500) {
      reply.serverError = error;
    }
    done();
  });

  fastify.addHook("onResponse", (request, reply, done) => {
    if (request.method.toUpperCase() !== "OPTIONS") {
      // Get path from routeOptions if available (from v4), otherwise fallback to deprecated routerPath
      const consumer = getConsumer(request);
      const path =
        "routeOptions" in request
          ? (request as any).routeOptions.url
          : (request as any).routerPath;
      const requestSize = request.headers["content-length"];
      let responseSize = reply.getHeader("content-length");
      if (Array.isArray(responseSize)) {
        responseSize = responseSize[0];
      }
      client.consumerRegistry.addOrUpdateConsumer(consumer);
      client.requestCounter.addRequest({
        consumer: consumer?.identifier,
        method: request.method,
        path: path,
        statusCode: reply.statusCode,
        responseTime: getResponseTime(reply),
        requestSize: requestSize,
        responseSize: responseSize,
      });
      if (
        (reply.statusCode === 400 || reply.statusCode === 422) &&
        reply.payload &&
        (!reply.payload.code || reply.payload.code === "FST_ERR_VALIDATION") &&
        typeof reply.payload.message === "string"
      ) {
        const validationErrors = extractAjvErrors(reply.payload.message);
        validationErrors.forEach((error) => {
          client.validationErrorCounter.addValidationError({
            consumer: consumer?.identifier,
            method: request.method,
            path: path,
            ...error,
          });
        });
      }
      if (reply.statusCode === 500 && reply.serverError) {
        client.serverErrorCounter.addServerError({
          consumer: consumer?.identifier,
          method: request.method,
          path: path,
          type: reply.serverError.name,
          msg: reply.serverError.message,
          traceback: reply.serverError.stack || "",
        });
      }
    }
    done();
  });
};

const getAppInfo = (routes: PathInfo[], appVersion?: string) => {
  const versions: Array<[string, string]> = [
    ["nodejs", process.version.replace(/^v/, "")],
  ];
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
    versions: Object.fromEntries(versions),
    client: "js:fastify",
  };
};

const getConsumer = (request: FastifyRequest) => {
  if (request.apitallyConsumer) {
    return consumerFromStringOrObject(request.apitallyConsumer);
  } else if (request.consumerIdentifier) {
    // For backwards compatibility
    process.emitWarning(
      "The consumerIdentifier property on the request object is deprecated. Use apitallyConsumer instead.",
      "DeprecationWarning",
    );
    return consumerFromStringOrObject(request.consumerIdentifier);
  }
  return null;
};

const getResponseTime = (reply: FastifyReply) => {
  if (reply.elapsedTime !== undefined) {
    return reply.elapsedTime;
  } else if (reply.getResponseTime !== undefined) {
    return reply.getResponseTime();
  }
  return 0;
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
