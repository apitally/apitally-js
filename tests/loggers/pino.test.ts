import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";

import type { LogRecord } from "../../src/common/requestLogger.js";
import { patchPinoLogger } from "../../src/loggers/index.js";

describe("Pino logger", () => {
  const logsContext = new AsyncLocalStorage<LogRecord[]>();
  const logger = pino({
    level: "info",
  });

  beforeAll(async () => {
    await patchPinoLogger(logger, logsContext);
  });

  it("Log formatting", () => {
    logsContext.run([], () => {
      logger.info("test");
      logger.error({ code: 500 }, "test error");

      const logs = logsContext.getStore();
      expect(logs).toBeDefined();
      expect(logs).toHaveLength(2);
      expect(logs![0].level).toBe("info");
      expect(logs![0].message).toBe("test");
      expect(logs![1].level).toBe("error");
      expect(logs![1].message).toBe('test error\n{"code":500}');
    });
  });
});
