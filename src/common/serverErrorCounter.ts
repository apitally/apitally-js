import type * as Sentry from "@sentry/node";
import { createHash } from "crypto";

import { ConsumerMethodPath, ServerError, ServerErrorsItem } from "./types.js";

const MAX_MSG_LENGTH = 2048;
const MAX_STACKTRACE_LENGTH = 65536;

export default class ServerErrorCounter {
  private errorCounts: Map<string, number>;
  private errorDetails: Map<string, ConsumerMethodPath & ServerError>;
  private sentryEventIds: Map<string, string>;
  private sentry: typeof Sentry | undefined;

  constructor() {
    this.errorCounts = new Map();
    this.errorDetails = new Map();
    this.sentryEventIds = new Map();
    this.tryImportSentry();
  }

  public addServerError(serverError: ConsumerMethodPath & ServerError) {
    const key = this.getKey(serverError);
    if (!this.errorDetails.has(key)) {
      this.errorDetails.set(key, serverError);
    }
    this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);
    this.captureSentryEventId(key);
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
          msg: this.getTruncatedMessage(serverError.msg),
          traceback: this.getTruncatedStack(serverError.traceback),
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

  private getTruncatedMessage(msg: string) {
    msg = msg.trim();
    if (msg.length <= MAX_MSG_LENGTH) {
      return msg;
    }
    const suffix = "... (truncated)";
    const cutoff = MAX_MSG_LENGTH - suffix.length;
    return msg.substring(0, cutoff) + suffix;
  }

  private getTruncatedStack(stack: string) {
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

  private captureSentryEventId(serverErrorKey: string) {
    if (this.sentry && this.sentry.lastEventId) {
      const eventId = this.sentry.lastEventId();
      if (eventId) {
        this.sentryEventIds.set(serverErrorKey, eventId);
      }
    }
  }

  private async tryImportSentry() {
    try {
      this.sentry = await import("@sentry/node");
    } catch (e) {
      // Sentry SDK is not installed, ignore
    }
  }
}
