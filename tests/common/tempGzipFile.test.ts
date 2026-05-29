import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import TempGzipFile from "../../src/common/tempGzipFile.js";

describe("Temporary gzip file", () => {
  it("End to end", async () => {
    const file = new TempGzipFile("test");
    expect(file.size).toBe(0);

    await file.writeLines([Buffer.from("test1"), Buffer.from("test2")]);

    // gzip buffers compressed output internally, so size only reflects bytes
    // written to the underlying file once the stream is flushed on close.
    await file.close();
    expect(file.size).toBeGreaterThan(0);

    const compressedData = await file.getContent();
    const content = gunzipSync(compressedData).toString();
    expect(content).toBe("test1\ntest2\n");

    await file.delete();
  });
});
