export async function measureResponseSize(
  response: Response,
): Promise<[number, Response]> {
  const [newResponse1, newResponse2] = await teeResponse(response);
  let size = 0;
  if (newResponse2.body) {
    let done = false;
    const reader = newResponse2.body.getReader();
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (!done && result.value) {
        size += result.value.byteLength;
      }
    }
  }
  return [size, newResponse1];
}

export async function getResponseBody(
  response: Response,
): Promise<[Buffer, Response]> {
  const [newResponse1, newResponse2] = await teeResponse(response);
  const responseBuffer = Buffer.from(await newResponse2.arrayBuffer());
  return [responseBuffer, newResponse1];
}

export async function getResponseJson(
  response: Response,
): Promise<[any, Response]> {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    const [newResponse1, newResponse2] = await teeResponse(response);
    const responseJson = await newResponse2.json();
    return [responseJson, newResponse1];
  }
  return [null, response];
}

export async function teeResponse(
  response: Response,
): Promise<[Response, Response]> {
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
