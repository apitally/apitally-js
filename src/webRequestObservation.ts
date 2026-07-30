import {
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type TextMapGetter,
} from "@opentelemetry/api";
import type { RPCMetadata } from "@opentelemetry/core";
import { BodyCapture, type CapturedBody } from "./capture.js";
import { getConfig } from "./config.js";
import type { RequestRecord, SpanHandle } from "./context.js";
import {
  resolveHttpRequestStartAttributes,
  startRequestObservation,
} from "./requestObservation.js";

const READ_TIMEOUT_MILLIS = 5_000;

const WEB_HEADERS_GETTER: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};

export interface StartWebRequestObservationOptions {
  request: Request;
  tracerName: string;
  clientAddress?: string;
}

export interface WebRequestObservation {
  requestRecord: RequestRecord;
  spanHandle: SpanHandle;
  rpcMetadata?: RPCMetadata;
  requestBodyCapture: BodyCapture;
  requestHeaders: Headers;
  startTimeMillis: number;
  method: string;
}

export interface StartedWebRequestObservation {
  observation: WebRequestObservation;
  requestContext: Context;
}

export function startWebRequestObservation(
  options: StartWebRequestObservationOptions,
): StartedWebRequestObservation {
  const { request } = options;
  const startTimeMillis = performance.now();
  const method = request.method.toUpperCase();
  const requestBodyCapture = new BodyCapture({
    captureBody: getConfig().captureRequestBody,
    contentType: request.headers.get("content-type"),
    contentLength: request.headers.get("content-length"),
    transferEncoding: request.headers.get("transfer-encoding"),
  });
  const attributeInput = {
    method,
    clientAddress: options.clientAddress,
    userAgent: request.headers.get("user-agent") ?? undefined,
    requestBodySize: requestBodyCapture.size,
  };
  let startAttributes = resolveHttpRequestStartAttributes(attributeInput);
  try {
    const url = new URL(request.url);
    startAttributes = resolveHttpRequestStartAttributes({
      ...attributeInput,
      path: url.pathname,
      query: url.search.slice(1) || undefined,
      scheme: url.protocol.replace(/:$/, ""),
      serverAddress: url.hostname,
      fullUrl: request.url,
    });
  } catch {
    // An unparseable request URL leaves only attributes from other request metadata.
  }
  const { requestRecord, requestContext, spanHandle, rpcMetadata } = startRequestObservation({
    activeContext: context.active(),
    extractedContext: propagation.extract(ROOT_CONTEXT, request.headers, WEB_HEADERS_GETTER),
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
      requestHeaders: request.headers,
      startTimeMillis,
      method,
    },
    requestContext,
  };
}

export interface WebResponseCompletion extends CapturedBody {
  completedAtMillis: number;
}

export interface CapturedWebResponse {
  response: Response;
  completion: Promise<WebResponseCompletion>;
}

// The response is teed so capture does not consume or delay the application's
// copy. Observation ends on completion, stream failure, or read timeout.
export function captureWebResponse(
  response: Response,
  shouldCaptureBody: boolean,
  readTimeoutMillis: number = READ_TIMEOUT_MILLIS,
): CapturedWebResponse {
  const bodyCapture = new BodyCapture({
    captureBody: shouldCaptureBody,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    transferEncoding: response.headers.get("transfer-encoding"),
  });
  if (!response.body) {
    bodyCapture.markComplete();
    return {
      response,
      completion: Promise.resolve({
        body: bodyCapture.body,
        size: bodyCapture.size,
        completedAtMillis: performance.now(),
      }),
    };
  }
  let readStarted = false;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, controller) => {
      readStarted = true;
      bodyCapture.addChunk(chunk);
      controller.enqueue(chunk);
    },
  });
  const pipePromise = response.body.pipeTo(writable).then(
    () => {
      const completedAtMillis = performance.now();
      bodyCapture.markComplete();
      return { body: bodyCapture.body, size: bodyCapture.size, completedAtMillis };
    },
    () => ({ completedAtMillis: performance.now() }),
  );
  let readTimeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<WebResponseCompletion>((resolve) => {
    readTimeout = setTimeout(() => {
      if (!readStarted) {
        resolve({ completedAtMillis: performance.now() });
      }
    }, readTimeoutMillis);
    readTimeout.unref();
  });
  const capturedResponse = new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const completion = Promise.race([pipePromise, timeoutPromise]).finally(() =>
    clearTimeout(readTimeout),
  );
  return { response: capturedResponse, completion };
}
