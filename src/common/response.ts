export async function measureResponseSize(
  response: Response,
  tee: boolean = true,
): Promise<[number, Response]> {
  const [newResponse1, newResponse2] = tee
    ? teeResponse(response)
    : [response, response];
  let size = 0;
  if (newResponse2.body) {
    try {
      let done = false;
      const reader = newResponse2.body.getReader();
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (!done && result.value) {
          size += result.value.byteLength;
        }
      }
    } catch (error) {
      // ignore
    }
  }
  return [size, newResponse1];
}

export async function getResponseBody(
  response: Response,
  tee: boolean = true,
): Promise<[Buffer, Response]> {
  const [newResponse1, newResponse2] = tee
    ? teeResponse(response)
    : [response, response];
  try {
    const responseBuffer = Buffer.from(await newResponse2.arrayBuffer());
    return [responseBuffer, newResponse1];
  } catch (error) {
    return [Buffer.from([]), newResponse1];
  }
}

export function teeResponse(response: Response): [Response, Response] {
  if (!response.body) {
    return [response, response];
  }
  const [stream1, stream2] = response.body.tee();
  const newResponse1 = new Response(stream1, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const newResponse2 = new Response(stream2, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return [newResponse1, newResponse2];
}

export function teeResponseBlob(
  response: Response,
  blob: string | Blob,
): [Response, Response] {
  const newResponse1 = new Response(blob, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const newResponse2 = new Response(blob, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return [newResponse1, newResponse2];
}

type CaptureResponseOptions = {
  captureBody: boolean;
  maxBodySize: number;
  readTimeout: number;
};

type CapturedResponse = {
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
  const promise = Promise.race([pipePromise, timeoutPromise]);

  const newResponse = new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  return [newResponse, promise];
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
