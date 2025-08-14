import { createHash } from "node:crypto";

import { getSentryEventId } from "./sentry.js";
import { ConsumerMethodPath, ServerError, ServerErrorsItem } from "./types.js";

const MAX_MSG_LENGTH = 2048;
const MAX_STACKTRACE_LENGTH = 65536;

export default class ServerErrorCounter {
  private errorCounts: Map<string, number>;
  private errorDetails: Map<string, ConsumerMethodPath & ServerError>;
  private sentryEventIds: Map<string, string>;

  constructor() {
    this.errorCounts = new Map();
    this.errorDetails = new Map();
    this.sentryEventIds = new Map();
  }

  public addServerError(serverError: ConsumerMethodPath & ServerError) {
    const key = this.getKey(serverError);
    if (!this.errorDetails.has(key)) {
      this.errorDetails.set(key, serverError);
    }
    this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);

    const sentryEventId = getSentryEventId();
    if (sentryEventId) {
      this.sentryEventIds.set(key, sentryEventId);
    }
  }

  public getAndResetServerErrors() {
    const data: Array<ServerErrorsItem> = [];
    this.errorCounts.forEach((count, key) => {
      const serverError = this.errorDetails.get(key);
      if (serverError) {
        data.push({
          consumer: serverError.consumer || null,
          method: serverError.method,
          path: serverError.path,
          type: serverError.type,
          msg: truncateExceptionMessage(serverError.msg),
          traceback: truncateExceptionStackTrace(serverError.traceback),
          sentry_event_id: this.sentryEventIds.get(key) || null,
          error_count: count,
        });
      }
    });
    this.errorCounts.clear();
    this.errorDetails.clear();
    return data;
  }

  private getKey(serverError: ConsumerMethodPath & ServerError) {
    const hashInput = [
      serverError.consumer || "",
      serverError.method.toUpperCase(),
      serverError.path,
      serverError.type,
      serverError.msg.trim(),
      serverError.traceback.trim(),
    ].join("|");
    return createHash("md5").update(hashInput).digest("hex");
  }
}

export function truncateExceptionMessage(msg: string) {
  if (msg.length <= MAX_MSG_LENGTH) {
    return msg;
  }
  const suffix = "... (truncated)";
  const cutoff = MAX_MSG_LENGTH - suffix.length;
  return msg.substring(0, cutoff) + suffix;
}

export function truncateExceptionStackTrace(stack: string) {
  const suffix = "... (truncated) ...";
  const cutoff = MAX_STACKTRACE_LENGTH - suffix.length;
  const lines = stack.trim().split("\n");
  const truncatedLines: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > cutoff) {
      truncatedLines.push(suffix);
      break;
    }
    truncatedLines.push(line);
    length += line.length + 1;
  }
  return truncatedLines.join("\n");
}
