import { describe, expect, it } from "vitest";
import { setConfig } from "../src/config.js";
import { REDACTED, Redaction } from "../src/redaction.js";
import { WRITE_TOKEN } from "./utils.js";

describe("redaction", () => {
  it("masks default and user-configured query params in bare query strings, request targets, and full URLs", () => {
    setConfig({ writeToken: WRITE_TOKEN, maskQueryParams: ["custom"] });
    const redaction = new Redaction();
    expect(
      redaction.redactQueryParams(
        "user=alice&apiKey=abc123&PASSWORD=hunter2&custom_id=7",
      ),
    ).toBe(
      "user=alice&apiKey=%5BREDACTED%5D&PASSWORD=%5BREDACTED%5D&custom_id=%5BREDACTED%5D",
    );
    expect(redaction.redactQueryParams("/items?secret=1&q=2", false)).toBe(
      "/items?secret=%5BREDACTED%5D&q=2",
    );
    expect(
      redaction.redactQueryParams("https://example.com/items?token=x", false),
    ).toBe("https://example.com/items?token=%5BREDACTED%5D");
  });

  it("preserves query params without a value", () => {
    const redaction = new Redaction();
    expect(redaction.redactQueryParams("/items?debug&x=1", false)).toBe(
      "/items?debug=&x=1",
    );
  });

  it("leaves request targets without a query string unchanged", () => {
    const redaction = new Redaction();
    expect(redaction.redactQueryParams("/items", false)).toBe("/items");
    expect(redaction.redactQueryParams("/items/key=value", false)).toBe(
      "/items/key=value",
    );
  });

  it("redacts headers matching default and user-configured patterns to a single [REDACTED] element", () => {
    setConfig({ writeToken: WRITE_TOKEN, maskHeaders: ["x-internal"] });
    const redaction = new Redaction();
    expect(
      redaction.redactHeaders({
        "content-type": ["application/json"],
        "x-api-key": ["abc", "def"],
        authorization: "Bearer xyz",
        "x-internal-id": ["1"],
      }),
    ).toEqual({
      "content-type": ["application/json"],
      "x-api-key": [REDACTED],
      authorization: REDACTED,
      "x-internal-id": [REDACTED],
    });
  });

  it("redacts headers whose names use underscores instead of dashes", () => {
    const redaction = new Redaction();
    expect(redaction.redactHeaders({ x_api_key: ["abc"] })).toEqual({
      x_api_key: [REDACTED],
    });
  });

  it("applies query param redaction to Location and Content-Location header values", () => {
    const redaction = new Redaction();
    expect(
      redaction.redactHeaders({
        Location: "/callback?token=secret&ok=1",
        "Content-Location": ["https://example.com/item?api-key=secret"],
      }),
    ).toEqual({
      Location: "/callback?token=%5BREDACTED%5D&ok=1",
      "Content-Location": ["https://example.com/item?api-key=%5BREDACTED%5D"],
    });
  });

  it("masks nested JSON body fields matching default and user-configured patterns, leaving other fields untouched", () => {
    setConfig({ writeToken: WRITE_TOKEN, maskBodyFields: ["nickname"] });
    const redaction = new Redaction();
    const body = Buffer.from(
      JSON.stringify(
        {
          user: { Password: "hunter2", nickname: "ace", age: 30 },
          items: [{ token: "t1" }, { token: 123 }],
          card_number: "4111111111111111",
          auth: { nested: "keep" },
          note: "hi",
        },
        null,
        2,
      ),
    );
    expect(redaction.redactBody(body)).toBe(
      JSON.stringify({
        user: { Password: REDACTED, nickname: REDACTED, age: 30 },
        items: [{ token: REDACTED }, { token: 123 }],
        card_number: REDACTED,
        auth: { nested: "keep" },
        note: "hi",
      }),
    );
  });

  it("returns a non-JSON text body as text without field redaction", () => {
    const redaction = new Redaction();
    expect(redaction.redactBody(Buffer.from("password=hunter2"))).toBe(
      "password=hunter2",
    );
  });

  it("passes a non-UTF-8 body through as bytes without field redaction", () => {
    const redaction = new Redaction();
    const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe]);
    const result = redaction.redactBody(body);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(body);
  });
});
