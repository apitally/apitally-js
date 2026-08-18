import type { IncomingMessage, ServerResponse } from "node:http";
import { type Context, context } from "@opentelemetry/api";
import type { Express, NextFunction, Request, Response } from "express";
import { activate, isActivated } from "../activation.js";
import { getConfig } from "../config.js";
import { captureException } from "../exceptions.js";
import { logWarning } from "../logger.js";
import { finalizeRequestObservation } from "../requestObservation.js";
import {
  captureNodeResponse,
  type NodeRequestObservation,
  type NodeResponseCompletion,
  registerServerCloseFlush,
  startNodeRequestObservation,
} from "../requestObservationNode.js";
import { beginRouteTracking, finishRouteTracking } from "./routes.js";

const HANDLE_WRAP_MARKER = Symbol.for("apitally.expressHandleWrap");
const TRACER_NAME = "apitally.express";

type HandleFunction = (
  req: IncomingMessage,
  res: ServerResponse,
  callback?: (error?: unknown) => void,
) => unknown;

// Wrapping app.handle observes unmatched routes and error responses regardless
// of middleware order. The marker prevents duplicate observation.
export function wrapAppHandle(app: Express): void {
  const markedApp = app as unknown as Record<symbol, boolean | undefined>;
  if (markedApp[HANDLE_WRAP_MARKER] === true) {
    return;
  }
  markedApp[HANDLE_WRAP_MARKER] = true;
  const originalHandle = (app as unknown as { handle: HandleFunction }).handle;
  let errorMiddlewareAppended = false;
  const appendErrorMiddlewareOnce = () => {
    if (errorMiddlewareAppended) {
      return;
    }
    errorMiddlewareAppended = true;
    // Appended on the first request so it sits below every handler the app
    // registered at setup; it records the exception and always passes it on.
    app.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
      captureException(error);
      next(error);
    });
  };
  (app as unknown as { handle: HandleFunction }).handle = function (
    this: unknown,
    req: IncomingMessage,
    res: ServerResponse,
    callback?: (error?: unknown) => void,
  ): unknown {
    let requestContext: Context | undefined;
    try {
      requestContext = observeRequest(req, res, appendErrorMiddlewareOnce);
    } catch (error) {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
    }
    if (!requestContext) {
      return originalHandle.call(this, req, res, callback);
    }
    return context.with(requestContext, () => originalHandle.call(this, req, res, callback));
  };
}

interface ExpressRequestObservation extends NodeRequestObservation {
  request: IncomingMessage;
  response: ServerResponse;
}

// Request setup precedes Express middleware so span, body, response, and route
// observation share one context.
function observeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  appendErrorMiddlewareOnce: () => void,
): Context | undefined {
  activate();
  if (!isActivated()) {
    return undefined;
  }
  appendErrorMiddlewareOnce();
  registerServerCloseFlush(request);
  const started = startNodeRequestObservation({ request, tracerName: TRACER_NAME });
  context.bind(started.requestContext, request);
  context.bind(started.requestContext, response);
  beginRouteTracking(request);
  const observation: ExpressRequestObservation = {
    ...started.observation,
    request,
    response,
  };
  captureNodeResponse(
    response,
    getConfig().captureResponseBody && observation.requestRecord.dropReason === undefined,
    observation.requestBodyCapture,
  )
    .then((completion) => finalizeRequestFromResponse(observation, completion))
    .catch((error: unknown) => {
      logWarning(`Error in the Apitally middleware: ${String(error)}`);
    });
  return started.requestContext;
}

function finalizeRequestFromResponse(
  observation: ExpressRequestObservation,
  completion: NodeResponseCompletion,
): void {
  const { request, response } = observation;
  const routeResult = finishRouteTracking(request, observation.requestUrl.split("?")[0]);
  if (routeResult.matchedUncapturedRegistration) {
    logWarning(
      'Some requests matched routes that Apitally did not capture at registration time. These requests are exported without a route template and are not counted in the request metrics. To resolve this, add `import "apitally/express/register";` as the first line of your application\'s entry module.',
    );
  }
  finalizeRequestObservation({
    observation,
    completedAtMillis: completion.completedAtMillis,
    statusCode: response.statusCode,
    route: routeResult.route,
    clientAddress: (request as Request).ip,
    requestHeaders: request.headers,
    responseHeaders: response.getHeaders(),
    capturedRequestBody: completion.requestBody,
    capturedResponseBody: completion,
  });
}
