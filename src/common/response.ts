type CaptureResponseOptions = {
  captureBody: boolean;
  maxBodySize: number;
  readTimeout: number;
};

export type CapturedResponse = {
  body?: Buffer;
  size: number;
  completed: boolean;
  error?: Error;
};

export function captureResponse(
  response: Response,
  {
    captureBody = false,
    maxBodySize = 0,
    readTimeout = 5000,
  }: Partial<CaptureResponseOptions> = {},
): [Response, Promise<CapturedResponse>] {
  if (!response.body) {
    return [
      response,
      Promise.resolve({
        size: 0,
        completed: true,
      }),
    ];
  }

  let size = 0;
  let bodySizeLimitExceeded = false;
  let readStarted = false;
  const chunks: Uint8Array[] = [];

  const { readable, writable } = new TransformStream({
    transform: (chunk, controller) => {
      readStarted = true;
      size += chunk.byteLength;
      if (captureBody && !bodySizeLimitExceeded) {
        if (size > maxBodySize) {
          bodySizeLimitExceeded = true;
          chunks.length = 0;
        } else {
          chunks.push(chunk);
        }
      }
      controller.enqueue(chunk);
    },
  });

  const pipePromise = response.body
    .pipeTo(writable)
    .then(() => ({
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      size,
      completed: true,
    }))
    .catch((error) => ({
      size,
      completed: false,
      error,
    }));
  const timeoutPromise = new Promise<CapturedResponse>((resolve) =>
    setTimeout(() => {
      if (!readStarted) {
        resolve({
          size: 0,
          completed: false,
        });
      }
    }, readTimeout),
  );
  const racePromise = Promise.race([pipePromise, timeoutPromise]);

  const newResponse = new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  // Force Bun to initialize the headers (workaround for lazy evaluation in Bun's Response implementation)
  void newResponse.headers;

  return [newResponse, racePromise];
}

export function getResponseJson(body: Buffer) {
  if (body.length === 0) {
    return null;
  }
  try {
    return JSON.parse(body.toString());
  } catch (error) {
    return null;
  }
}
