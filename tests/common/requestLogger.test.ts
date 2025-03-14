import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gunzipSync } from "zlib";

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

  it("End to end", async () => {
    expect(requestLogger.enabled).toBe(true);

    for (let i = 0; i < 3; i++) {
      requestLogger.logRequest(
        {
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
        },
        {
          statusCode: 200,
          responseTime: 0.123,
          headers: [["content-type", "text/plain"]],
          size: 4,
          body: Buffer.from("test"),
        },
        new Error("test"),
      );
    }

    await requestLogger.writeToFile();
    await requestLogger.rotateFile();
    const file = requestLogger.getFile();
    expect(file).toBeDefined();

    const compressedData = await file!.getContent();
    expect(compressedData.length).toBeGreaterThan(0);

    file!.delete();

    const jsonLines = gunzipSync(compressedData)
      .toString()
      .trimEnd()
      .split("\n");
    expect(jsonLines.length).toBe(3);

    const items = jsonLines.map((line) => JSON.parse(line));
    expect(items[0].request.method).toBe("GET");
    expect(items[0].request.url).toBe("http://localhost:8000/test?foo=bar");
    expect(atob(items[0].request.body)).toBe("test");
    expect(items[0].response.statusCode).toBe(200);
    expect(atob(items[0].response.body)).toBe("test");
    expect(items[0].exception.type).toBe("Error");
    expect(items[0].exception.message).toBe("test");
  });

  it("Log exclusions", async () => {
    requestLogger.config.logQueryParams = false;
    requestLogger.config.logRequestHeaders = false;
    requestLogger.config.logRequestBody = false;
    requestLogger.config.logResponseHeaders = false;
    requestLogger.config.logResponseBody = false;
    requestLogger.config.excludePaths = [/\/excluded$/i];
    requestLogger.config.excludeCallback = (request, response) =>
      response.statusCode === 404;

    const request: Request = {
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
    };
    const response: Response = {
      statusCode: 200,
      responseTime: 0.123,
      headers: [["content-type", "text/plain"]],
      size: 4,
      body: Buffer.from("test"),
    };

    requestLogger.logRequest(request, response);
    expect(requestLogger["pendingWrites"].length).toBe(1);
    const item = JSON.parse(requestLogger["pendingWrites"][0]);
    expect(item.request.url).toBe("http://localhost:8000/test");
    expect(item.request.headers).toBeUndefined();
    expect(item.request.body).toBeUndefined();
    expect(item.response.headers).toBeUndefined();
    expect(item.response.body).toBeUndefined();

    response.statusCode = 404;
    requestLogger.logRequest(request, response);
    expect(requestLogger["pendingWrites"].length).toBe(1);
    response.statusCode = 200;

    request.path = "/api/excluded";
    requestLogger.logRequest(request, response);
    expect(requestLogger["pendingWrites"].length).toBe(1);

    request.path = "/healthz";
    requestLogger.logRequest(request, response);
    expect(requestLogger["pendingWrites"].length).toBe(1);
  });

  it("Log masking", async () => {
    requestLogger.config.maskQueryParams = [/test/i];
    requestLogger.config.maskHeaders = [/test/i];
    requestLogger.config.maskRequestBodyCallback = (request) =>
      request.path !== "/test" ? request.body : null;
    requestLogger.config.maskResponseBodyCallback = (request, response) =>
      request.path !== "/test" ? response.body : null;

    const request: Request = {
      timestamp: Date.now() / 1000,
      method: "GET",
      path: "/test",
      url: "http://localhost/test?secret=123456&test=123456&other=abcdef",
      headers: [
        ["accept", "text/plain"],
        ["content-type", "text/plain"],
        ["authorization", "Bearer 123456"],
        ["x-test", "123456"],
      ],
      size: 4,
      body: Buffer.from("test"),
    };
    const response: Response = {
      statusCode: 200,
      responseTime: 0.123,
      headers: [["content-type", "text/plain"]],
      size: 4,
      body: Buffer.from("test"),
    };

    requestLogger.logRequest(request, response);
    expect(requestLogger["pendingWrites"].length).toBe(1);
    const item = JSON.parse(requestLogger["pendingWrites"][0]);
    expect(item.request.url).toBe(
      "http://localhost/test?secret=******&test=******&other=abcdef",
    );
    expect(item.request.headers).toEqual([
      ["accept", "text/plain"],
      ["content-type", "text/plain"],
      ["authorization", "******"],
      ["x-test", "******"],
    ]);
    expect(atob(item.request.body)).toBe("<masked>");
    expect(atob(item.response.body)).toBe("<masked>");
  });

  afterEach(async () => {
    if (requestLogger) {
      await requestLogger.close();
    }
  });
});
