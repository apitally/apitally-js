import {
  extractZodValidationErrors,
  isRecord,
  normalizeSource,
  type ValidationErrorDetail,
} from "../validationErrors.js";

// Recognized response shapes: zod issues, express-validator, and celebrate.
export function extractExpressValidationErrors(body: unknown): ValidationErrorDetail[] {
  if (!isRecord(body)) {
    return [];
  }
  const zodDetails = extractZodValidationErrors(body);
  if (zodDetails.length > 0) {
    return zodDetails;
  }
  if (Array.isArray(body.errors)) {
    return extractExpressValidatorErrors(body.errors);
  }
  if (isRecord(body.validation)) {
    return extractCelebrateErrors(body.validation);
  }
  return [];
}

function extractExpressValidatorErrors(errors: unknown[]): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];
  for (const error of errors) {
    if (
      !isRecord(error) ||
      error.type !== "field" ||
      typeof error.path !== "string" ||
      typeof error.msg !== "string"
    ) {
      continue;
    }
    const source = normalizeSource(error.location);
    if (source) {
      details.push({ source, field: error.path, message: error.msg, type: "" });
    }
  }
  return details;
}

// Celebrate joins the messages of all failed keys into one sentence list, so
// each key takes the sentence naming it.
function extractCelebrateErrors(validation: Record<string, unknown>): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];
  for (const error of Object.values(validation)) {
    if (!isRecord(error) || !Array.isArray(error.keys) || typeof error.message !== "string") {
      continue;
    }
    const sentences = error.message.split(". ");
    for (const key of error.keys) {
      if (typeof key === "string") {
        details.push({
          source: normalizeSource(error.source),
          field: key,
          message: sentences.find((sentence) => sentence.includes(`"${key}"`)) ?? error.message,
          type: "",
        });
      }
    }
  }
  return details;
}
