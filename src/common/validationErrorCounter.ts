import { createHash } from "node:crypto";

import {
  ConsumerMethodPath,
  ValidationError,
  ValidationErrorsItem,
} from "./types.js";

export default class ValidationErrorCounter {
  private errorCounts: Map<string, number>;
  private errorDetails: Map<string, ConsumerMethodPath & ValidationError>;

  constructor() {
    this.errorCounts = new Map();
    this.errorDetails = new Map();
  }

  public addValidationError(
    validationError: ConsumerMethodPath & ValidationError,
  ) {
    const key = this.getKey(validationError);
    if (!this.errorDetails.has(key)) {
      this.errorDetails.set(key, validationError);
    }
    this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);
  }

  public getAndResetValidationErrors() {
    const data: Array<ValidationErrorsItem> = [];
    this.errorCounts.forEach((count, key) => {
      const validationError = this.errorDetails.get(key);
      if (validationError) {
        data.push({
          consumer: validationError.consumer || null,
          method: validationError.method,
          path: validationError.path,
          loc: validationError.loc.split("."),
          msg: validationError.msg,
          type: validationError.type,
          error_count: count,
        });
      }
    });
    this.errorCounts.clear();
    this.errorDetails.clear();
    return data;
  }

  private getKey(validationError: ConsumerMethodPath & ValidationError) {
    const hashInput = [
      validationError.consumer || "",
      validationError.method.toUpperCase(),
      validationError.path,
      validationError.loc,
      validationError.msg.trim(),
      validationError.type,
    ].join("|");
    return createHash("md5").update(hashInput).digest("hex");
  }
}
