import { AsyncLocalStorage } from "async_hooks";
import { format } from "util";

import type { LogRecord } from "../common/requestLogger.js";

type LogLevel = "log" | "warn" | "error" | "info" | "debug";

const MAX_BUFFER_SIZE = 1000;

let isPatched = false;
let globalLogsContext: AsyncLocalStorage<LogRecord[]>;

export function patchConsole(logsContext: AsyncLocalStorage<LogRecord[]>) {
  globalLogsContext = logsContext;

  if (isPatched) {
    return;
  }

  const logMethods: LogLevel[] = ["log", "warn", "error", "info", "debug"];
  logMethods.forEach((method) => {
    const originalMethod = console[method];
    console[method] = function (...args: any[]) {
      captureLog(method, args);
      return originalMethod.apply(console, args);
    };
  });

  isPatched = true;
}

function captureLog(level: LogLevel, args: any[]) {
  const logs = globalLogsContext?.getStore();
  if (logs && logs.length < MAX_BUFFER_SIZE) {
    logs.push({
      timestamp: Date.now() / 1000,
      logger: "console",
      level,
      message: format(...args),
    });
  }
}
