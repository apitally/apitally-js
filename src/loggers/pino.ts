import { AsyncLocalStorage } from "node:async_hooks";

import type { LogRecord } from "../common/requestLogger.js";
import { formatMessage, removeKeys } from "./utils.js";

const MAX_BUFFER_SIZE = 1000;

const originalStreamSym = Symbol.for("apitally.originalStream");
const logLevelMap: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export async function patchPinoLogger(
  logger: any,
  logsContext: AsyncLocalStorage<LogRecord[]>,
) {
  try {
    // Find stream and message key symbols on the logger and its prototype
    const symbols = [
      ...Object.getOwnPropertySymbols(logger),
      ...Object.getOwnPropertySymbols(Object.getPrototypeOf(logger)),
    ];
    const streamSym = symbols.find(
      (sym) => sym.toString() === "Symbol(pino.stream)",
    );
    const messageKeySym = symbols.find(
      (sym) => sym.toString() === "Symbol(pino.messageKey)",
    );
    if (!streamSym || !messageKeySym) {
      // not a pino logger
      return false;
    }

    if (!(originalStreamSym in logger)) {
      logger[originalStreamSym] = logger[streamSym];
    }

    const originalStream = logger[originalStreamSym];
    if (originalStream) {
      const pino = await import("pino");
      const captureStream = new ApitallyLogCaptureStream(
        logsContext,
        logger[messageKeySym],
      );
      logger[streamSym] = pino.default.multistream(
        [
          { level: 0, stream: originalStream },
          { level: 0, stream: captureStream },
        ],
        {
          levels: logger.levels,
        },
      );
    }
    return true;
  } catch {
    // ignore errors
    return false;
  }
}

function filterLogs(obj: any, messageKey: string) {
  return obj[messageKey] !== "request completed";
}

class ApitallyLogCaptureStream {
  private logsContext: AsyncLocalStorage<LogRecord[]>;
  private messageKey: string;

  constructor(logsContext: AsyncLocalStorage<LogRecord[]>, messageKey: string) {
    this.logsContext = logsContext;
    this.messageKey = messageKey;
  }

  write(msg: string): void {
    const logs = this.logsContext.getStore();
    if (!logs || !msg || logs.length >= MAX_BUFFER_SIZE) {
      return;
    }

    let obj: any;
    try {
      obj = JSON.parse(msg);
    } catch (e) {
      return;
    }
    if (
      obj === null ||
      typeof obj !== "object" ||
      !filterLogs(obj, this.messageKey)
    ) {
      return;
    }

    try {
      let message = obj[this.messageKey];
      const ignoreKeys = [
        "hostname",
        "level",
        this.messageKey,
        "pid",
        "time",
        "reqId",
        "req",
        "res",
      ];
      if (!message && "data" in obj && "tags" in obj) {
        // hapi-pino uses data and tags instead of the message key
        message = obj.data;
        ignoreKeys.push("data");
        ignoreKeys.push("tags");
      }
      const rest = removeKeys(obj, ignoreKeys);
      const formattedMessage = formatMessage(message, rest);
      if (formattedMessage) {
        logs.push({
          timestamp: this.convertTime(obj.time),
          level: logLevelMap[obj.level] || "info",
          message: formattedMessage,
        });
      }
    } catch (e) {
      // ignore
    }
  }

  private convertTime(time: any): number {
    if (typeof time === "number" && !isNaN(time)) {
      return time / 1000; // Convert milliseconds to seconds
    }
    return Date.now() / 1000; // Fallback to current time
  }
}
