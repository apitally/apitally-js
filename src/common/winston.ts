import { AsyncLocalStorage } from "async_hooks";

import type { LogRecord } from "./requestLogger.js";

let isPatched = false;
let globalLogsContext: AsyncLocalStorage<LogRecord[]>;

export function patchWinston(logsContext: AsyncLocalStorage<LogRecord[]>) {
  globalLogsContext = logsContext;

  if (isPatched) {
    return;
  }

  // @ts-expect-error - file is not typed
  import("winston/lib/winston/logger.js")
    .then((loggerModule) => {
      if (loggerModule.default?.prototype?.write) {
        const originalWrite = loggerModule.default.prototype.write;
        loggerModule.default.prototype.write = function (info: any) {
          captureLog(info);
          return originalWrite.call(this, info);
        };
      }
    })
    .catch(() => {
      // winston is not installed, silently ignore
    });

  isPatched = true;
}

function captureLog(info: any) {
  const logs = globalLogsContext?.getStore();
  if (!logs || !info) {
    return;
  }

  try {
    const stringifiedRest = JSON.stringify(
      Object.assign({}, info, {
        timestamp: undefined,
        level: undefined,
        message: undefined,
        splat: undefined,
      }),
    );
    const formattedMessage =
      (info.message || "") +
      (stringifiedRest !== "{}" ? ` ${stringifiedRest}` : "");
    if (formattedMessage) {
      logs.push({
        timestamp: parseTimestamp(info.timestamp),
        level: info.level || "info",
        message: formattedMessage.trim(),
      });
    }
  } catch (e) {
    // ignore
  }
}

function parseTimestamp(timestamp: any) {
  if (timestamp) {
    const ts = new Date(timestamp).getTime();
    if (!isNaN(ts)) {
      return ts / 1000;
    }
  }
  return Date.now() / 1000;
}
