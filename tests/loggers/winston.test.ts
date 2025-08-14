import { AsyncLocalStorage } from "node:async_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import winston from "winston";

import { LogRecord } from "../../src/common/requestLogger.js";
import { patchWinston } from "../../src/loggers/index.js";

describe("Winston logger", () => {
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

  beforeAll(async () => {
    await patchWinston(logsContext);
  });

  it("Log formatting", () => {
    const logger = winston.createLogger({
      level: "info",
      transports: [new winston.transports.Console()],
    });

    logsContext.run([], () => {
      logger.info("test", { foo: "bar" });
      logger.error("test", { code: 500 });
      logger.error(new Error("test error"));

      const logs = logsContext.getStore();
      expect(logs).toBeDefined();
      expect(logs).toHaveLength(3);
      expect(logs![0].level).toBe("info");
      expect(logs![0].message).toBe('test\n{"foo":"bar"}');
      expect(logs![1].level).toBe("error");
      expect(logs![1].message).toBe('test\n{"code":500}');
      expect(logs![2].level).toBe("error");
      expect(logs![2].message).toBe("test error");
    });
  });
});
