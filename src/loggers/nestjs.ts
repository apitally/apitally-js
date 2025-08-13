import { AsyncLocalStorage } from "async_hooks";

import type { LogRecord } from "../common/requestLogger.js";
import { formatMessage } from "./utils.js";

type LogLevel = "log" | "error" | "warn" | "debug" | "verbose" | "fatal";

let isPatched = false;
let globalLogsContext: AsyncLocalStorage<LogRecord[]>;

export async function patchNestLogger(
  logsContext: AsyncLocalStorage<LogRecord[]>,
) {
  globalLogsContext = logsContext;

  if (isPatched) {
    return;
  }

  try {
    const { Logger } = await import("@nestjs/common");
    const logMethods: LogLevel[] = [
      "log",
      "error",
      "warn",
      "debug",
      "verbose",
      "fatal",
    ];

    // Patch static methods
    logMethods.forEach((method) => {
      const originalMethod = Logger[method];
      Logger[method] = function (message: any, ...args: any[]) {
        captureLog(method, [message, ...args]);
        return originalMethod.apply(Logger, [message, ...args]);
      };
    });

    // Patch prototype methods to affect all instances (new and existing)
    logMethods.forEach((method) => {
      const originalMethod = Logger.prototype[method];
      Logger.prototype[method] = function (message: any, ...args: any[]) {
        captureLog(method, [message, ...args], this.context);
        return originalMethod.apply(this, [message, ...args]);
      };
    });

    isPatched = true;
  } catch {
    // @nestjs/common is not installed, silently ignore
  }
}

function captureLog(level: LogLevel, args: any[], context?: string) {
  const logs = globalLogsContext?.getStore();
  if (logs && logs.length < 1000) {
    logs.push({
      timestamp: Date.now() / 1000,
      logger: context,
      level,
      message: formatMessage(args[0], ...args.slice(1)),
    });
  }
}
