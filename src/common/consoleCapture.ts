import { AsyncLocalStorage } from "async_hooks";
import { format } from "util";
import { LogRecord } from "./requestLogger.js";

type LogLevel = "log" | "warn" | "error" | "info" | "debug";
type ConsoleMethod = (...args: any[]) => void;

const ORIGINAL_METHODS = Symbol("apitally.originalConsoleMethods");

interface PatchedConsole extends Console {
  [ORIGINAL_METHODS]?: {
    [K in LogLevel]: ConsoleMethod;
  };
}

export function patchConsole(requestContext: AsyncLocalStorage<LogRecord[]>) {
  const patchedConsole = console as PatchedConsole;

  if (!patchedConsole[ORIGINAL_METHODS]) {
    patchedConsole[ORIGINAL_METHODS] = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    };
  }

  const captureLog = (level: LogLevel, args: any[]) => {
    const originalMethod = patchedConsole[ORIGINAL_METHODS]![level];
    const logs = requestContext.getStore();
    if (logs) {
      logs.push({
        timestamp: Date.now() / 1000,
        level,
        message: format(...args),
      });
    }
    originalMethod.apply(console, args);
  };

  console.log = (...args) => captureLog("log", args);
  console.warn = (...args) => captureLog("warn", args);
  console.error = (...args) => captureLog("error", args);
  console.info = (...args) => captureLog("info", args);
  console.debug = (...args) => captureLog("debug", args);
}
