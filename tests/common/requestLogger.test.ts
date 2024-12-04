import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gunzipSync } from "zlib";

import RequestLogger from "../../src/common/requestLogger.js";

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
    expect(atob(items[0].request.body)).toBe("test");
    expect(items[0].response.statusCode).toBe(200);
    expect(atob(items[0].response.body)).toBe("test");
  });

  afterEach(async () => {
    if (requestLogger) {
      await requestLogger.close();
    }
  });
});
