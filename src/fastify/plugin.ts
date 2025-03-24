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
import { convertBody, convertHeaders } from "../common/requestLogger.js";
import {
  ApitallyConfig,
  ApitallyConsumer,
  PathInfo,
  ValidationError,
} from "../common/types.js";
import { parseContentLength } from "../common/utils.js";

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
    const contentType = reply.getHeader("content-type") as string | undefined;
    if (client.requestLogger.isSupportedContentType(contentType)) {
      reply.payload = payload;
    }
    done();
  });

  fastify.addHook("onError", (request, reply, error, done) => {
    if (!error.statusCode || error.statusCode === 500) {
      reply.serverError = error;
    }
    done();
  });

  fastify.addHook("onResponse", (request, reply, done) => {
    if (client.isEnabled() && request.method.toUpperCase() !== "OPTIONS") {
      // Get path from routeOptions if available (from v4), otherwise fallback to deprecated routerPath
      const consumer = getConsumer(request);
      const path =
        "routeOptions" in request
          ? (request as any).routeOptions.url
          : (request as any).routerPath;
      const requestSize = parseContentLength(request.headers["content-length"]);
      const responseSize = parseContentLength(
        reply.getHeader("content-length"),
      );
      const responseTime = getResponseTime(reply);
      client.consumerRegistry.addOrUpdateConsumer(consumer);
      client.requestCounter.addRequest({
        consumer: consumer?.identifier,
        method: request.method,
        path,
        statusCode: reply.statusCode,
        responseTime,
        requestSize: requestSize,
        responseSize: responseSize,
      });
      if (
        (reply.statusCode === 400 || reply.statusCode === 422) &&
        reply.payload
      ) {
        try {
          const parsedPayload = JSON.parse(reply.payload);
          if (
            (!parsedPayload.code ||
              parsedPayload.code === "FST_ERR_VALIDATION") &&
            typeof parsedPayload.message === "string"
          ) {
            const validationErrors = extractAjvErrors(parsedPayload.message);
            validationErrors.forEach((error) => {
              client.validationErrorCounter.addValidationError({
                consumer: consumer?.identifier,
                method: request.method,
                path: path,
                ...error,
              });
            });
          }
        } catch (error) {} // eslint-disable-line no-empty
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
      if (client.requestLogger.enabled) {
        client.requestLogger.logRequest(
          {
            timestamp: Date.now() / 1000,
            method: request.method,
            path,
            url: `${request.protocol}://${request.host ?? request.hostname}${request.originalUrl ?? request.url}`,
            headers: convertHeaders(request.headers),
            size: Number(requestSize),
            consumer: consumer?.identifier,
            body: convertBody(request.body, request.headers["content-type"]),
          },
          {
            statusCode: reply.statusCode,
            responseTime: responseTime / 1000,
            headers: convertHeaders(reply.getHeaders()),
            size: Number(responseSize),
            body: convertBody(
              reply.payload,
              reply.getHeader("content-type")?.toString(),
            ),
          },
          reply.serverError,
        );
      }
    }
    done();
  });
};

const getAppInfo = (routes: PathInfo[], appVersion?: string) => {
  const versions = [["nodejs", process.version.replace(/^v/, "")]];
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
  } else if ((reply as any).getResponseTime !== undefined) {
    return (reply as any).getResponseTime();
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
