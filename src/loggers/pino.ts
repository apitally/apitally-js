import { AsyncLocalStorage } from "async_hooks";

import { LogRecord } from "../common/requestLogger.js";
import { formatMessage, removeKeys } from "./utils.js";

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
    const pino = await import("pino");
    if (!(pino.default.symbols.streamSym in logger)) {
      return;
    }
    if (!(originalStreamSym in logger)) {
      logger[originalStreamSym] = logger[pino.default.symbols.streamSym];
    }

    const originalStream = logger[originalStreamSym];
    if (originalStream) {
      const messageKey = logger[pino.default.symbols.messageKeySym];
      const captureStream = new ApitallyLogCaptureStream(
        logsContext,
        messageKey,
      );
      logger[pino.default.symbols.streamSym] = pino.default.multistream(
        [
          { level: 0, stream: originalStream },
          { level: 0, stream: captureStream },
        ],
        {
          levels: logger.levels,
        },
      );
    }
  } catch {
    // pino is not installed, silently ignore
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
    if (!logs || !msg) {
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
      const message = obj[this.messageKey];
      const rest = removeKeys(obj, [
        "hostname",
        "level",
        this.messageKey,
        "pid",
        "time",
        "reqId",
        "req",
        "res",
      ]);
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
