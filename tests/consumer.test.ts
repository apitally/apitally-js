import { describe, expect, it } from "vitest";
import {
  type ApitallyConsumer,
  consumerFromStringOrObject,
} from "../src/consumer.js";

describe("consumer", () => {
  it("creates a consumer from a string identifier, trimmed and capped at 128 characters", () => {
    expect(consumerFromStringOrObject("  acme-corp  ")).toEqual({
      identifier: "acme-corp",
    });
    expect(consumerFromStringOrObject("x".repeat(200))).toEqual({
      identifier: "x".repeat(128),
    });
  });

  it("trims and caps identifier, name, and group from a consumer object", () => {
    expect(
      consumerFromStringOrObject({
        identifier: `  ${"i".repeat(200)}  `,
        name: `  ${"n".repeat(100)}  `,
        group: `  ${"g".repeat(100)}  `,
      }),
    ).toEqual({
      identifier: "i".repeat(128),
      name: "n".repeat(64),
      group: "g".repeat(64),
    });
  });

  it("accepts a numeric identifier and converts it to a string", () => {
    expect(consumerFromStringOrObject(123)).toEqual({ identifier: "123" });
    expect(
      consumerFromStringOrObject({ identifier: 123 as unknown as string }),
    ).toEqual({ identifier: "123" });
  });

  it("drops empty name and group from a consumer object", () => {
    expect(
      consumerFromStringOrObject({ identifier: "acme", name: "  ", group: "" }),
    ).toEqual({ identifier: "acme" });
  });

  it("returns no consumer for a missing, empty, or invalid identifier", () => {
    expect(consumerFromStringOrObject("")).toBeUndefined();
    expect(consumerFromStringOrObject("   ")).toBeUndefined();
    expect(consumerFromStringOrObject(undefined)).toBeUndefined();
    expect(consumerFromStringOrObject(null)).toBeUndefined();
    expect(consumerFromStringOrObject({} as ApitallyConsumer)).toBeUndefined();
    expect(consumerFromStringOrObject({ identifier: "  " })).toBeUndefined();
    expect(
      consumerFromStringOrObject({ identifier: true as unknown as string }),
    ).toBeUndefined();
  });
});
