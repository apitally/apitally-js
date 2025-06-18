import { describe, expect, it } from "vitest";

import { mergeHeaders, parseContentLength } from "../../src/common/headers.js";

describe("Header utils", () => {
  it("Parse content length", async () => {
    expect(parseContentLength(100)).toBe(100);
    expect(parseContentLength("100")).toBe(100);
    expect(parseContentLength(["100", "200"])).toBe(100);
    expect(parseContentLength(undefined)).toBeUndefined();
    expect(parseContentLength(null)).toBeUndefined();
    expect(parseContentLength("")).toBeUndefined();
    expect(parseContentLength("abc")).toBeUndefined();
  });

  it("Merge headers", async () => {
    const headers1 = new Headers();
    headers1.set("X-Test1", "test1");
    headers1.set("X-Test2", "test22");

    const headers2 = new Headers();
    headers2.set("X-Test2", "test2");
    headers2.set("X-Test3", "test3");

    const merged = mergeHeaders(headers1, headers2);
    expect(merged.get("X-Test1")).toBe("test1");
    expect(merged.get("X-Test2")).toBe("test2");
    expect(merged.get("X-Test3")).toBe("test3");
  });
});
