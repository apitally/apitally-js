import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import RequestLogger, {
  Request,
  Response,
} from "../../src/common/requestLogger.js";

describe("Request logger", () => {
  let requestLogger: RequestLogger;

  beforeEach(() => {
    requestLogger = new RequestLogger({
      enabled: true,
      logQueryParams: true,
      logRequestHeaders: true,
      logRequestBody: true,
      logResponseHeaders: true,
      logResponseBody: true,
    });
  });

  afterEach(async () => {
    if (requestLogger) {
      await requestLogger.close();
    }
  });

  const createRequest = (): Request => ({
    timestamp: Date.now() / 1000,
    method: "GET",
    path: "/test",
    url: "http://localhost:8000/test?foo=bar",
    headers: [
      ["accept", "text/plain"],
      ["content-type", "text/plain"],
    ],
    size: 4,
    consumer: "test",
    body: Buffer.from("test"),
  });

  const createResponse = (): Response => ({
    statusCode: 200,
    responseTime: 0.123,
    headers: [["content-type", "text/plain"]],
    size: 4,
    body: Buffer.from("test"),
  });

  const getLoggedItems = async (
    requestLogger: RequestLogger,
  ): Promise<any[]> => {
    await requestLogger.writeToFile();
    await requestLogger.rotateFile();
    const file = requestLogger.getFile();

    if (!file) {
      return [];
    }

    const compressedData = await file!.getContent();
    file!.delete();

    return gunzipSync(compressedData)
      .toString()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  };

  it("End to end", async () => {
    expect(requestLogger.enabled).toBe(true);

    for (let i = 0; i < 3; i++) {
      requestLogger.logRequest(
        createRequest(),
        createResponse(),
        new Error("test"),
      );
    }

    const items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(3);

    for (const item of items) {
      expect(item.request.method).toBe("GET");
      expect(item.request.url).toBe("http://localhost:8000/test?foo=bar");
      expect(atob(item.request.body)).toBe("test");
      expect(item.response.statusCode).toBe(200);
      expect(atob(item.response.body)).toBe("test");
      expect(item.exception.type).toBe("Error");
      expect(item.exception.message).toBe("test");
    }
  });

  it("Log config", async () => {
    requestLogger.config.logQueryParams = false;
    requestLogger.config.logRequestHeaders = false;
    requestLogger.config.logRequestBody = false;
    requestLogger.config.logResponseHeaders = false;
    requestLogger.config.logResponseBody = false;

    requestLogger.logRequest(createRequest(), createResponse());
    const items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(1);

    const item = items[0];
    expect(item.request.url).toBe("http://localhost:8000/test");
    expect(item.request.headers).toBeUndefined();
    expect(item.request.body).toBeUndefined();
    expect(item.response.headers).toBeUndefined();
    expect(item.response.body).toBeUndefined();
  });

  it("Log exclusions", async () => {
    requestLogger.config.excludePaths = [/\/excluded$/i];
    requestLogger.config.excludeCallback = (request, response) =>
      response.statusCode === 404;

    const request = createRequest();
    const response = createResponse();

    // Normal request should be logged
    requestLogger.logRequest(request, response);
    let items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(1);

    // Request with 404 should be excluded
    response.statusCode = 404;
    requestLogger.logRequest(request, response);
    items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(0);

    // Request with excluded path should be excluded
    response.statusCode = 200;
    request.path = "/api/excluded";
    requestLogger.logRequest(request, response);
    items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(0);

    // Health check path should be excluded (built-in)
    request.path = "/healthz";
    requestLogger.logRequest(request, response);
    items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(0);

    // ELB health checker should be excluded (built-in)
    request.path = "/";
    request.headers = [["user-agent", "ELB-HealthChecker/2.0"]];
    requestLogger.logRequest(request, response);
    items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(0);
  });

  it("Mask headers", async () => {
    requestLogger.config.maskHeaders = [/test/i];

    const request = createRequest();
    const response = createResponse();
    request.headers = [
      ["accept", "text/plain"],
      ["content-type", "text/plain"],
      ["authorization", "Bearer 123456"],
      ["x-test", "123456"],
    ];

    requestLogger.logRequest(request, response);
    const items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(1);

    const item = items[0];
    const headers = item.request.headers;
    expect(headers).toContainEqual(["accept", "text/plain"]);
    expect(headers).toContainEqual(["content-type", "text/plain"]);
    expect(headers).toContainEqual(["authorization", "******"]);
    expect(headers).toContainEqual(["x-test", "******"]);
  });

  it("Mask query params", async () => {
    requestLogger.config.maskQueryParams = [/test/i];

    const request = createRequest();
    const response = createResponse();
    request.url =
      "http://localhost/test?secret=123456&test=123456&other=abcdef";

    requestLogger.logRequest(request, response);
    const items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(1);

    const item = items[0];
    expect(item.request.url).toBe(
      "http://localhost/test?secret=******&test=******&other=abcdef",
    );
  });

  it("Mask body callbacks", async () => {
    requestLogger.config.maskRequestBodyCallback = (request) =>
      request.path !== "/test" ? request.body : null;
    requestLogger.config.maskResponseBodyCallback = (request, response) =>
      request.path !== "/test" ? response.body : null;

    const request = createRequest();
    const response = createResponse();

    requestLogger.logRequest(request, response);
    const items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(1);

    const item = items[0];
    expect(atob(item.request.body)).toBe("<masked>");
    expect(atob(item.response.body)).toBe("<masked>");
  });

  it("Mask body fields", async () => {
    requestLogger.config.maskBodyFields = [/custom/i];

    const requestBody = {
      username: "john_doe",
      password: "secret123",
      token: "abc123",
      custom: "xyz789",
      user_id: 42,
      api_key: 123,
      normal_field: "value",
      nested: {
        password: "nested_secret",
        count: 5,
        deeper: { auth: "deep_token" },
      },
      array: [
        { password: "array_secret", id: 1 },
        { normal: "text", token: "array_token" },
      ],
    };
    const responseBody = {
      status: "success",
      secret: "response_secret",
      data: { pwd: "response_pwd" },
    };

    const request = createRequest();
    const response = createResponse();
    request.headers = [["content-type", "application/json"]];
    request.body = Buffer.from(JSON.stringify(requestBody));
    response.headers = [["content-type", "application/json"]];
    response.body = Buffer.from(JSON.stringify(responseBody));

    requestLogger.logRequest(request, response);
    const items = await getLoggedItems(requestLogger);
    expect(items.length).toBe(1);

    const item = items[0];
    const maskedRequestBody = JSON.parse(atob(item.request.body));
    const maskedResponseBody = JSON.parse(atob(item.response.body));

    // Test fields that should be masked
    expect(maskedRequestBody.password).toBe("******");
    expect(maskedRequestBody.token).toBe("******");
    expect(maskedRequestBody.custom).toBe("******");
    expect(maskedRequestBody.nested.password).toBe("******");
    expect(maskedRequestBody.nested.deeper.auth).toBe("******");
    expect(maskedRequestBody.array[0].password).toBe("******");
    expect(maskedRequestBody.array[1].token).toBe("******");
    expect(maskedResponseBody.secret).toBe("******");
    expect(maskedResponseBody.data.pwd).toBe("******");

    // Test fields that should NOT be masked
    expect(maskedRequestBody.username).toBe("john_doe");
    expect(maskedRequestBody.user_id).toBe(42);
    expect(maskedRequestBody.api_key).toBe(123);
    expect(maskedRequestBody.normal_field).toBe("value");
    expect(maskedRequestBody.nested.count).toBe(5);
    expect(maskedRequestBody.array[0].id).toBe(1);
    expect(maskedRequestBody.array[1].normal).toBe("text");
    expect(maskedResponseBody.status).toBe("success");
  });
});
