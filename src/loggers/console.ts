import { AsyncLocalStorage } from "async_hooks";

import type { LogRecord } from "../common/requestLogger.js";
import { formatMessage } from "./utils.js";

type LogLevel = "log" | "warn" | "error" | "info" | "debug";

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
  if (logs && logs.length < 1000) {
    logs.push({
      timestamp: Date.now() / 1000,
      level,
      message: formatMessage(args[0], ...args.slice(1)),
    });
  }
}
