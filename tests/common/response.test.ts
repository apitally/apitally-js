import { describe, expect, it } from "vitest";

import { captureResponse, getResponseJson } from "../../src/common/response.js";

describe("Response utils", () => {
  it("Capture response", async () => {
    const body = "Hello world";
    const response = new Response(body);

    const [newResponse, promise] = captureResponse(response, {
      captureBody: true,
      maxBodySize: 1024,
    });
    const responseText = await newResponse.text();
    const capturedResponse = await promise;
    expect(responseText).toBe(body);
    expect(capturedResponse.body).toEqual(Buffer.from(body));
    expect(capturedResponse.size).toBe(body.length);
    expect(capturedResponse.completed).toBe(true);
  });

  it("Capture response (body too large)", async () => {
    const body = "Hello world";
    const response = new Response(body);

    const [newResponse, promise] = captureResponse(response, {
      captureBody: true,
      maxBodySize: 8,
    });
    const responseText = await newResponse.text();
    const capturedResponse = await promise;
    expect(responseText).toBe(body);
    expect(capturedResponse.body).toBeUndefined();
    expect(capturedResponse.size).toBe(body.length);
  });

  it("Get response JSON", () => {
    let body = Buffer.from('{"foo":"bar"}');
    let json = getResponseJson(body);
    expect(json).toEqual({ foo: "bar" });

    body = Buffer.from("");
    json = getResponseJson(body);
    expect(json).toBeNull();

    body = Buffer.from("null");
    json = getResponseJson(body);
    expect(json).toBeNull();

    body = Buffer.from("not valid JSON");
    json = getResponseJson(body);
    expect(json).toBeNull();
  });
});
