import type { RequestEvent } from "@hapi/hapi";
import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

import type { LogRecord } from "../common/requestLogger.js";

const MAX_BUFFER_SIZE = 1000;
const VALID_LOG_LEVELS = new Set<string>([
  "trace",
  "debug",
  "info",
  "warn",
  "warning",
  "error",
  "fatal",
]);

export function handleHapiRequestEvent(
  event: RequestEvent,
  logsContext: AsyncLocalStorage<LogRecord[]>,
) {
  const logs = logsContext.getStore();
  if (!logs || logs.length >= MAX_BUFFER_SIZE) {
    return;
  }

  logs.push({
    timestamp: Number(event.timestamp) / 1000,
    level:
      event.tags.find((tag) => VALID_LOG_LEVELS.has(tag.toLowerCase())) ||
      "log",
    message: format(event.data),
  });
}
