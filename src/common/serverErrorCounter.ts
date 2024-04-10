import { createHash } from "crypto";

import { ConsumerMethodPath, ServerError, ServerErrorsItem } from "./types.js";

export default class ServerErrorCounter {
  private errorCounts: Map<string, number>;
  private errorDetails: Map<string, ConsumerMethodPath & ServerError>;

  constructor() {
    this.errorCounts = new Map();
    this.errorDetails = new Map();
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

  public addServerError(serverError: ConsumerMethodPath & ServerError) {
    const key = this.getKey(serverError);
    if (!this.errorDetails.has(key)) {
      this.errorDetails.set(key, serverError);
    }
    this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);
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
          msg: serverError.msg,
          traceback: serverError.traceback,
          error_count: count,
        });
      }
    });
    this.errorCounts.clear();
    this.errorDetails.clear();
    return data;
  }
}
