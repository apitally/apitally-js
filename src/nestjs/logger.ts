import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { format } from "util";

import { LogRecord } from "../common/requestLogger.js";

type LogLevel = "log" | "error" | "warn" | "debug" | "verbose" | "fatal";

let isPatched = false;
let globalLogsContext: AsyncLocalStorage<LogRecord[]>;

export function patchNestLogger(logsContext: AsyncLocalStorage<LogRecord[]>) {
  globalLogsContext = logsContext;

  if (isPatched) {
    return;
  }

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
}

function captureLog(level: LogLevel, args: any[], context?: string) {
  const logs = globalLogsContext?.getStore();
  if (logs) {
    logs.push({
      timestamp: Date.now() / 1000,
      logger: context,
      level,
      message: format(...args),
    });
  }
}
