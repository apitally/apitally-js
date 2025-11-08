import { setImmediate } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import TempGzipFile from "../../src/common/tempGzipFile.js";

describe("Temporary gzip file", () => {
  it("End to end", async () => {
    const file = new TempGzipFile();
    expect(file.size).toBe(0);

    await file.writeLine(Buffer.from("test1"));
    await file.writeLine(Buffer.from("test2"));

    // Wait for the next event loop cycle to ensure gzip stream has flushed to file
    await setImmediate();
    expect(file.size).toBeGreaterThan(0);

    await file.close();

    const compressedData = await file.getContent();
    const content = gunzipSync(compressedData).toString();
    expect(content).toBe("test1\ntest2\n");

    await file.delete();
  });
});
