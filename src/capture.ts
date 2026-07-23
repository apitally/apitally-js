import {
  BODY_TOO_LARGE_BUFFER,
  isAllowedContentType,
  MAX_BODY_SIZE,
} from "./config.js";

const READ_TIMEOUT_MILLIS = 5_000;

export interface BodyCaptureOptions {
  captureBody: boolean;
  contentType?: string | null;
  contentLength?: string | number | string[] | null;
  transferEncoding?: string | string[] | null;
}

// Accumulates one direction's body under the capture rules while counting every
// observed byte independent of capture. The capture decisions are header-only:
// outside the content-type allow-list the body is never buffered, and a declared
// over-cap size short-circuits to the sentinel without buffering a byte.
export class BodyCapture {
  private readonly shouldCapture: boolean;
  private readonly declaredSize?: number;
  private tooLarge: boolean;
  private chunks: Uint8Array[] = [];
  private bufferedLength = 0;
  private observedLength = 0;
  private completed = false;

  constructor(options: BodyCaptureOptions) {
    this.shouldCapture =
      options.captureBody && isAllowedContentType(options.contentType);
    // A Content-Length combined with chunked transfer encoding describes the
    // payload before chunking, not the wire bytes, and is not trusted.
    this.declaredSize = isChunkedTransferEncoding(options.transferEncoding)
      ? undefined
      : parseContentLength(options.contentLength);
    this.tooLarge =
      this.shouldCapture &&
      this.declaredSize !== undefined &&
      this.declaredSize > MAX_BODY_SIZE;
  }

  addChunk(
    chunk: Buffer | Uint8Array | string,
    encoding?: BufferEncoding,
  ): void {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
    this.observedLength += bytes.byteLength;
    if (!this.shouldCapture || this.tooLarge) {
      return;
    }
    this.bufferedLength += bytes.byteLength;
    if (this.bufferedLength > MAX_BODY_SIZE) {
      // A body must never be exported truncated, so crossing the cap discards
      // the buffer and yields the sentinel.
      this.tooLarge = true;
      this.chunks = [];
      return;
    }
    this.chunks.push(bytes);
  }

  markComplete(): void {
    this.completed = true;
  }

  // The sentinel is exported even when the stream never completed; a partial
  // buffer from an aborted stream never is.
  get body(): Buffer | undefined {
    if (this.tooLarge) {
      return BODY_TOO_LARGE_BUFFER;
    }
    if (!this.completed || this.bufferedLength === 0) {
      return undefined;
    }
    return Buffer.concat(this.chunks);
  }

  // The trusted declared size, else the running byte count once the stream was
  // observed to completion; undefined means no size attribute.
  get size(): number | undefined {
    if (this.declaredSize !== undefined) {
      return this.declaredSize;
    }
    return this.completed ? this.observedLength : undefined;
  }
}

export interface CapturedBody {
  body?: Buffer;
  size?: number;
  completed: boolean;
}

// Tees the response body so the SDK observes the wire bytes without consuming
// or delaying the app's copy. The returned response replaces the original; the
// promise settles when the body was fully sent, the stream aborted, or reading
// never started within the timeout.
export function captureResponse(
  response: Response,
  captureBody: boolean,
  readTimeoutMillis: number = READ_TIMEOUT_MILLIS,
): [Response, Promise<CapturedBody>] {
  const bodyCapture = new BodyCapture({
    captureBody,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    transferEncoding: response.headers.get("transfer-encoding"),
  });
  if (!response.body) {
    bodyCapture.markComplete();
    return [response, Promise.resolve(capturedBodyResult(bodyCapture, true))];
  }
  let readStarted = false;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, controller) => {
      readStarted = true;
      bodyCapture.addChunk(chunk);
      controller.enqueue(chunk);
    },
  });
  const pipePromise = response.body
    .pipeTo(writable)
    .then(() => {
      bodyCapture.markComplete();
      return capturedBodyResult(bodyCapture, true);
    })
    .catch(() => capturedBodyResult(bodyCapture, false));
  // A response nobody ever reads would leave the pipe promise pending forever.
  let readTimeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<CapturedBody>((resolve) => {
    readTimeout = setTimeout(() => {
      if (!readStarted) {
        resolve({ completed: false });
      }
    }, readTimeoutMillis);
    readTimeout.unref();
  });
  const teedResponse = new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // Force Bun to initialize the headers (workaround for lazy evaluation in
  // Bun's Response implementation).
  void teedResponse.headers;
  const capturedBodyPromise = Promise.race([
    pipePromise,
    timeoutPromise,
  ]).finally(() => clearTimeout(readTimeout));
  return [teedResponse, capturedBodyPromise];
}

// Normalizes headers into the stash shape: lowercase names, multi-value headers
// kept as arrays. Values stay raw; redaction runs at the export boundary.
export function normalizeHeaders(
  headers: Headers | Record<string, string | number | string[] | undefined>,
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  if (isWebHeaders(headers)) {
    // Web Headers combine duplicates themselves; only set-cookie repeats.
    for (const [name, value] of headers) {
      const existing = normalized[name];
      if (existing === undefined) {
        normalized[name] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        normalized[name] = [existing, value];
      }
    }
    return normalized;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized[name.toLowerCase()] = Array.isArray(value)
        ? value
        : String(value);
    }
  }
  return normalized;
}

function capturedBodyResult(
  bodyCapture: BodyCapture,
  completed: boolean,
): CapturedBody {
  return { body: bodyCapture.body, size: bodyCapture.size, completed };
}

// Duck-typed on iterability: a plain header record has no Symbol.iterator, and
// the Headers instance may come from another realm's implementation.
function isWebHeaders(headers: object): headers is Headers {
  return typeof (headers as Headers)[Symbol.iterator] === "function";
}

function parseContentLength(
  value: string | number | string[] | null | undefined,
): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (Array.isArray(value)) {
    return parseContentLength(value[0]);
  }
  return undefined;
}

function isChunkedTransferEncoding(
  value: string | string[] | null | undefined,
): boolean {
  const joined = Array.isArray(value) ? value.join(",") : value;
  return typeof joined === "string" && joined.toLowerCase().includes("chunked");
}
