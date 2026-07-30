// Captured bodies above the cap are represented by a sentinel and never
// exported truncated.
export const MAX_BODY_SIZE = 50_000;
export const BODY_TOO_LARGE = "[BODY_TOO_LARGE]";
export const BODY_TOO_LARGE_BUFFER = Buffer.from(BODY_TOO_LARGE);

const ALLOWED_CONTENT_TYPES = [
  "application/json",
  "application/problem+json",
  "application/vnd.api+json",
  "application/ld+json",
  "application/x-ndjson",
  "text/markdown",
  "text/plain",
];

interface BodyCaptureOptions {
  captureBody: boolean;
  contentType?: string | null;
  contentLength?: string | number | string[] | null;
  transferEncoding?: string | string[] | null;
}

// Capture eligibility and declared oversize decisions use headers only; all
// observed bytes still count toward size.
export class BodyCapture {
  private shouldCapture: boolean;
  private readonly declaredSize?: number;
  private tooLarge: boolean;
  private chunks: Uint8Array[] = [];
  private bufferedLength = 0;
  private observedLength = 0;
  private completed = false;

  constructor(options: BodyCaptureOptions) {
    this.shouldCapture = options.captureBody && isAllowedContentType(options.contentType);
    // Transfer-Encoding: chunked makes Content-Length unusable, so observed
    // decoded bytes determine size.
    const transferEncoding = Array.isArray(options.transferEncoding)
      ? options.transferEncoding.join(",")
      : options.transferEncoding;
    const isChunkedTransferEncoding =
      typeof transferEncoding === "string" && transferEncoding.toLowerCase().includes("chunked");
    this.declaredSize = isChunkedTransferEncoding
      ? undefined
      : parseContentLength(options.contentLength);
    this.tooLarge =
      this.shouldCapture && this.declaredSize !== undefined && this.declaredSize > MAX_BODY_SIZE;
  }

  addChunk(chunk: Buffer | Uint8Array | string, encoding?: BufferEncoding): void {
    const byteLength =
      typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    this.observedLength += byteLength;
    if (!this.shouldCapture || this.tooLarge) {
      return;
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
    this.bufferedLength += byteLength;
    if (this.bufferedLength > MAX_BODY_SIZE) {
      // A body must never be exported truncated, so crossing the cap discards
      // the buffer and yields the sentinel.
      this.tooLarge = true;
      this.chunks = [];
      return;
    }
    this.chunks.push(bytes);
  }

  stopBuffering(): void {
    this.shouldCapture = false;
    this.tooLarge = false;
    this.chunks = [];
    this.bufferedLength = 0;
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
}

function isAllowedContentType(contentType: string | null | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const normalized = contentType.trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((allowed) => normalized.startsWith(allowed));
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
