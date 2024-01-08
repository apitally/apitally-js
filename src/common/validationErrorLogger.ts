import {
  ConsumerMethodPath,
  ValidationError,
  ValidationErrorsItem,
} from "./types.js";

export default class ValidationErrorLogger {
  private errorCounts: Map<string, number>;

  constructor() {
    this.errorCounts = new Map<string, number>();
  }

  private getKey(validationError: ConsumerMethodPath & ValidationError) {
    return [
      validationError.consumer || "",
      validationError.method.toUpperCase(),
      validationError.path,
      validationError.loc,
      validationError.msg,
      validationError.type,
    ].join("|");
  }

  public logValidationError(
    validationError: ConsumerMethodPath & ValidationError,
  ) {
    const key = this.getKey(validationError);
    this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);
  }

  public getAndResetValidationErrors() {
    const data: Array<ValidationErrorsItem> = [];
    this.errorCounts.forEach((count, key) => {
      const [consumer, method, path, loc, msg, type] = key.split("|");
      data.push({
        consumer: consumer || null,
        method,
        path,
        loc: loc.split("."),
        msg,
        type,
        error_count: count,
      });
    });
    this.errorCounts.clear();
    return data;
  }
}
