import {
  ConsumerMethodPath,
  ValidationError,
  ValidationErrorsItem,
} from "./types";

export default class ValidationErrorLogger {
  private errorCounts: Map<string, number>;

  constructor() {
    this.errorCounts = new Map<string, number>();
  }

  private getKey(
    validationError: ConsumerMethodPath & ValidationError
  ): string {
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
    validationError: ConsumerMethodPath & ValidationError
  ): void {
    const key = this.getKey(validationError);
    this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);
  }

  public getAndResetValidationErrors(): Array<ValidationErrorsItem> {
    const data: Array<any> = [];
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
