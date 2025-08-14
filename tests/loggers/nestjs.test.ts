import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { beforeAll, describe, expect, it } from "vitest";

import { LogRecord } from "../../src/common/requestLogger.js";
import { patchNestLogger } from "../../src/loggers/index.js";

describe("NestJS logger", () => {
  const logsContext = new AsyncLocalStorage<LogRecord[]>();

  beforeAll(async () => {
    await patchNestLogger(logsContext);
  });

  it("Log formatting", () => {
    const logger = new Logger("TestService");

    logsContext.run([], () => {
      logger.log("test message");
      logger.error("test error", { code: 500 });

      const logs = logsContext.getStore();
      expect(logs).toBeDefined();
      expect(logs).toHaveLength(2);
      expect(logs![0].logger).toBe("TestService");
      expect(logs![0].level).toBe("log");
      expect(logs![0].message).toBe("test message");
      expect(logs![1].level).toBe("error");
      expect(logs![1].message).toBe('test error\n{"code":500}');
    });
  });
});
