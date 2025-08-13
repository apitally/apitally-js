import { AsyncLocalStorage } from "async_hooks";

import type { LogRecord } from "../common/requestLogger.js";
import { formatMessage, removeKeys } from "./utils.js";

const MAX_BUFFER_SIZE = 1000;

let isPatched = false;
let globalLogsContext: AsyncLocalStorage<LogRecord[]>;

export async function patchWinston(
  logsContext: AsyncLocalStorage<LogRecord[]>,
) {
  globalLogsContext = logsContext;

  if (isPatched) {
    return;
  }

  try {
    // @ts-expect-error - file is not typed
    const loggerModule = await import("winston/lib/winston/logger.js");
    if (loggerModule.default?.prototype?.write) {
      const originalWrite = loggerModule.default.prototype.write;
      loggerModule.default.prototype.write = function (info: any) {
        captureLog(info);
        return originalWrite.call(this, info);
      };
    }
  } catch {
    // winston is not installed, silently ignore
  }

  isPatched = true;
}

function captureLog(info: any) {
  const logs = globalLogsContext?.getStore();
  if (!logs || !info || logs.length >= MAX_BUFFER_SIZE) {
    return;
  }

  try {
    const rest = removeKeys(info, ["timestamp", "level", "message", "splat"]);
    const formattedMessage = formatMessage(info.message, rest);
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
