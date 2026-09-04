import type { HttpContext } from "@adonisjs/core/http";
import type { ApitallyOptions } from "../config.js";
import { getRequestRecord } from "../context.js";
import { captureException as captureCurrentException } from "../exceptions.js";
import { logDebug } from "../logger.js";
import {
  isRecord,
  isValidationResponseStatus,
  type ValidationErrorDetail,
} from "../validationErrors.js";

export type { ApitallyOptions } from "../config.js";

export function defineConfig(options: ApitallyOptions): ApitallyOptions {
  return options;
}

export function captureException(error: unknown, context: HttpContext): void {
  try {
    const statusCode = context.response.getStatus();
    if (statusCode >= 500) {
      captureCurrentException(error);
      return;
    }
    if (
      !isValidationResponseStatus(statusCode) ||
      !isRecord(error) ||
      error.code !== "E_VALIDATION_ERROR" ||
      !Array.isArray(error.messages)
    ) {
      return;
    }
    const requestRecord = getRequestRecord();
    if (!requestRecord) {
      return;
    }
    const validationErrors: ValidationErrorDetail[] = [];
    for (const message of error.messages) {
      if (
        isRecord(message) &&
        typeof message.field === "string" &&
        typeof message.message === "string"
      ) {
        validationErrors.push({
          source: "",
          field: message.field,
          message: message.message,
          type: typeof message.rule === "string" ? message.rule : "",
        });
      }
    }
    requestRecord.validationErrors = validationErrors;
  } catch (captureError) {
    logDebug(`Error capturing an AdonisJS exception: ${String(captureError)}`);
  }
}
