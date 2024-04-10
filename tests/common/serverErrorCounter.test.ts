import { describe, expect, it } from "vitest";

import ServerErrorCounter from "../../src/common/serverErrorCounter.js";

describe("Server error counter", () => {
  it("Message and stacktrace truncation", () => {
    const serverErrorCounter = new ServerErrorCounter();
    const serverError = {
      consumer: "test",
      method: "GET",
      path: "/test",
      type: "error",
      msg: "a".repeat(3000),
      traceback: "one line\n".repeat(8000),
    };
    serverErrorCounter.addServerError(serverError);
    const serverErrors = serverErrorCounter.getAndResetServerErrors();
    expect(serverErrors.length).toBe(1);
    expect(serverErrors[0].msg.length).toBe(2048);
    expect(serverErrors[0].msg).toContain("(truncated)");
    expect(serverErrors[0].traceback.length).toBeLessThan(65536);
    expect(serverErrors[0].traceback).toContain("(truncated)");
  });
});
