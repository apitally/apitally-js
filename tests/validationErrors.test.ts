import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  addValidationErrors,
  drainValidationErrors,
  extractZodValidationErrors,
  formatIssues,
  parseJsonResponseBody,
} from "../src/validationErrors.js";

const DETAIL = { source: "body", field: "name", message: "Required", type: "invalid_type" };

describe("validationErrors", () => {
  it("aggregates identical details per consumer, method, and route, keeps at most 100 groups, and drains them once", () => {
    addValidationErrors(undefined, "post", "/items", [DETAIL, DETAIL]);
    addValidationErrors("acme", "POST", "/items", [{ ...DETAIL, message: "x".repeat(3_000) }]);
    addValidationErrors(undefined, "OPTIONS", "/items", [DETAIL]);
    addValidationErrors(undefined, "POST", "", [DETAIL]);
    for (let index = 0; index < 100; index++) {
      addValidationErrors(undefined, "POST", `/route-${index}`, [DETAIL]);
    }
    addValidationErrors(undefined, "POST", "/items", [DETAIL]);

    const groups = drainValidationErrors();
    expect(groups).toHaveLength(100);
    expect(groups[0]).toEqual({ method: "POST", path: "/items", ...DETAIL, count: 3 });
    expect(groups[1]).toEqual({
      consumer: "acme",
      method: "POST",
      path: "/items",
      ...DETAIL,
      message: "x".repeat(2_048),
      count: 1,
    });
    expect(drainValidationErrors()).toEqual([]);
  });

  it("formats zod and Standard Schema issues from both zod response serializations", () => {
    const issues = [
      { code: "invalid_type", path: ["items", 0, { key: "name" }], message: "Required" },
    ];
    const expected = [
      { source: "", field: "items.0.name", message: "Required", type: "invalid_type" },
    ];
    expect(
      extractZodValidationErrors({ success: false, error: { issues, name: "ZodError" } }),
    ).toEqual(expected);
    expect(
      extractZodValidationErrors({
        success: false,
        error: { name: "ZodError", message: JSON.stringify(issues) },
      }),
    ).toEqual(expected);
    expect(formatIssues([{ path: "/name", message: "Expected string" }], "body")).toEqual([
      { source: "body", field: "name", message: "Expected string", type: "" },
    ]);
  });

  it("parses identity and gzip JSON bodies and yields nothing for anything else", () => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    expect(parseJsonResponseBody(body, undefined)).toEqual({ ok: true });
    expect(parseJsonResponseBody(gzipSync(body), "gzip")).toEqual({ ok: true });
    expect(parseJsonResponseBody(body, "br")).toBeUndefined();
    expect(parseJsonResponseBody(Buffer.from("[BODY_TOO_LARGE]"), undefined)).toBeUndefined();
    const oversized = Buffer.from(JSON.stringify({ padding: "a".repeat(60_000) }));
    expect(parseJsonResponseBody(gzipSync(oversized), "gzip")).toBeUndefined();
  });
});
