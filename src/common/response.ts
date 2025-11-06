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

export async function getResponseJson(
  response: Response,
): Promise<[any, Response]> {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    const [newResponse1, newResponse2] = teeResponse(response);
    try {
      const responseJson = await newResponse2.json();
      return [responseJson, newResponse1];
    } catch (error) {
      return [null, newResponse1];
    }
  }
  return [null, response];
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
