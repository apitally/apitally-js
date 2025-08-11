import { AsyncLocalStorage } from "async_hooks";
import pino from "pino";

import { LogRecord } from "./requestLogger.js";

const logLevelMap: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export function patchPino(
  logger: pino.BaseLogger,
  logsContext: AsyncLocalStorage<LogRecord[]>,
  filterLogs: (obj: any) => boolean = () => true,
): void {
  const loggerInternal = logger as any; // Cast to access internal pino properties
  const originalStream = loggerInternal[pino.symbols.streamSym];

  if (originalStream) {
    const messageKey = loggerInternal[pino.symbols.messageKeySym];
    const captureStream = new ApitallyLogCaptureStream(
      logsContext,
      messageKey,
      filterLogs,
    );
    loggerInternal[pino.symbols.streamSym] = pino.multistream(
      [
        { level: 0, stream: originalStream },
        { level: 0, stream: captureStream },
      ],
      {
        levels: loggerInternal.levels,
      },
    );
  }
}

class ApitallyLogCaptureStream implements pino.DestinationStream {
  private logsContext: AsyncLocalStorage<LogRecord[]>;
  private messageKey: string;
  private filterLogs: (obj: any) => boolean;

  constructor(
    logsContext: AsyncLocalStorage<LogRecord[]>,
    messageKey: string,
    filterLogs: (obj: any) => boolean = () => true,
  ) {
    this.logsContext = logsContext;
    this.messageKey = messageKey;
    this.filterLogs = filterLogs;
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
    if (obj === null || typeof obj !== "object" || !this.filterLogs(obj)) {
      return;
    }

    try {
      if (typeof obj[this.messageKey] === "string") {
        logs.push({
          timestamp: this.convertTime(obj.time),
          level: logLevelMap[obj.level] || "info",
          message: obj[this.messageKey],
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
