import type { IncomingMessage, ServerResponse } from "node:http";
import { type Context, context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import type { RPCMetadata } from "@opentelemetry/core";
import { getActivationHandles } from "./activation.js";
import { BodyCapture, type CapturedBody } from "./bodyCapture.js";
import { getConfig } from "./config.js";
import type { RequestRecord, SpanHandle } from "./context.js";
import { logDebug } from "./logger.js";
import {
  resolveHttpRequestStartAttributes,
  startRequestObservation,
} from "./requestObservation.js";

const flushOnCloseServers = new WeakSet<object>();

export interface StartNodeRequestObservationOptions {
  request: IncomingMessage;
  tracerName: string;
}

export interface NodeRequestObservation {
  requestRecord: RequestRecord;
  spanHandle: SpanHandle;
  rpcMetadata?: RPCMetadata;
  requestBodyCapture: BodyCapture;
  startTimeMillis: number;
  method: string;
  requestUrl: string;
}

export interface StartedNodeRequestObservation {
  observation: NodeRequestObservation;
  requestContext: Context;
}

export function startNodeRequestObservation(
  options: StartNodeRequestObservationOptions,
): StartedNodeRequestObservation {
  const { request } = options;
  const startTimeMillis = performance.now();
  const method = (request.method ?? "GET").toUpperCase();
  const requestUrl = request.url ?? "/";
  const requestBodyCapture = new BodyCapture({
    captureBody: getConfig().captureRequestBody,
    contentType: request.headers["content-type"],
    contentLength: request.headers["content-length"],
    transferEncoding: request.headers["transfer-encoding"],
  });
  observeRequestBody(request, requestBodyCapture);

  const queryIndex = requestUrl.indexOf("?");
  const scheme = (request.socket as { encrypted?: boolean } | undefined)?.encrypted
    ? "https"
    : "http";
  const host = request.headers.host;
  let serverAddress: string | undefined;
  if (host) {
    try {
      serverAddress = new URL(`${scheme}://${host}`).hostname;
    } catch {
      // An invalid Host header leaves the server address unset.
    }
  }
  const startAttributes = resolveHttpRequestStartAttributes({
    method,
    path: queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex),
    query: queryIndex === -1 ? undefined : requestUrl.slice(queryIndex + 1) || undefined,
    scheme,
    serverAddress,
    fullUrl: host ? `${scheme}://${host}${requestUrl}` : undefined,
    clientAddress: request.socket?.remoteAddress || undefined,
    userAgent:
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
    requestBodySize: requestBodyCapture.size,
  });
  const { requestRecord, requestContext, spanHandle, rpcMetadata } = startRequestObservation({
    activeContext: context.active(),
    extractedContext: propagation.extract(ROOT_CONTEXT, request.headers),
    tracerName: options.tracerName,
    method,
    startAttributes,
    requestBodyCapture,
  });
  return {
    observation: {
      requestRecord,
      spanHandle,
      rpcMetadata,
      requestBodyCapture,
      startTimeMillis,
      method,
      requestUrl,
    },
    requestContext,
  };
}

export interface NodeResponseCompletion extends CapturedBody {
  completedAtMillis: number;
  responseFinished: boolean;
  requestBody: CapturedBody;
}

// Patching write and end before framework dispatch lets compression wrappers
// feed their final wire bytes through capture.
export function captureNodeResponse(
  response: ServerResponse,
  shouldCaptureBody: boolean,
  requestBodyCapture?: BodyCapture,
): Promise<NodeResponseCompletion> {
  let responseBodyCapture: BodyCapture | undefined;
  const ensureResponseBodyCapture = (): BodyCapture => {
    responseBodyCapture ??= new BodyCapture({
      captureBody: shouldCaptureBody,
      contentType: firstStringValue(response.getHeader("content-type")),
      contentLength: response.getHeader("content-length") as string | number | string[] | undefined,
      transferEncoding: response.getHeader("transfer-encoding") as string | string[] | undefined,
    });
    return responseBodyCapture;
  };
  const recordResponseChunk = (args: unknown[]): void => {
    try {
      const chunk = args[0];
      if (typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        ensureResponseBodyCapture().addChunk(
          chunk,
          typeof args[1] === "string" ? (args[1] as BufferEncoding) : undefined,
        );
      }
    } catch (error) {
      logDebug(`Error observing a response chunk: ${String(error)}`);
    }
  };
  const originalWrite = response.write as (...args: unknown[]) => boolean;
  response.write = function (this: ServerResponse, ...args: unknown[]): boolean {
    recordResponseChunk(args);
    return originalWrite.apply(this, args);
  } as typeof response.write;
  const originalEnd = response.end as (...args: unknown[]) => ServerResponse;
  response.end = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
    recordResponseChunk(args);
    return originalEnd.apply(this, args);
  } as typeof response.end;

  return new Promise((resolve) => {
    let completed = false;
    const complete = (responseFinished: boolean): void => {
      if (completed) {
        return;
      }
      completed = true;
      const completedAtMillis = performance.now();
      const capture = ensureResponseBodyCapture();
      if (responseFinished) {
        capture.markComplete();
      }
      resolve({
        body: capture.body,
        size: capture.size,
        completedAtMillis,
        responseFinished,
        requestBody: {
          body: requestBodyCapture?.body,
          size: requestBodyCapture?.size,
        },
      });
    };
    response.on("finish", () => complete(true));
    response.on("close", () => complete(false));
  });
}

// Closing a server triggers a flush of buffered telemetry, never a teardown:
// an app bound to several servers keeps exporting on the still-open ones.
export function registerServerCloseFlush(request: IncomingMessage): void {
  const server = (request.socket as { server?: unknown } | undefined)?.server;
  if (
    !server ||
    typeof (server as { on?: unknown }).on !== "function" ||
    flushOnCloseServers.has(server as object)
  ) {
    return;
  }
  flushOnCloseServers.add(server as object);
  (server as { on: (event: string, listener: () => void) => void }).on("close", () => {
    const worker = getActivationHandles()?.worker;
    if (worker) {
      worker.runCycle().catch((error: unknown) => {
        logDebug(`Error flushing telemetry on server close: ${String(error)}`);
      });
    }
  });
}

// Wrapping emit observes only bytes delivered to application consumers and does
// not change the stream's flow state.
function observeRequestBody(request: IncomingMessage, requestBodyCapture: BodyCapture): void {
  const originalEmit = request.emit as (...args: unknown[]) => boolean;
  (request as { emit: unknown }).emit = function (
    this: IncomingMessage,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    try {
      if (event === "data") {
        const chunk = args[0];
        if (typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
          requestBodyCapture.addChunk(chunk);
        }
      } else if (event === "end") {
        requestBodyCapture.markComplete();
      }
    } catch (error) {
      logDebug(`Error observing a request body chunk: ${String(error)}`);
    }
    return originalEmit.call(this, event, ...args);
  };
}

function firstStringValue(value: string | number | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return undefined;
}
