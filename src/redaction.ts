import {
  compilePatterns,
  DEFAULT_MASK_BODY_FIELDS,
  DEFAULT_MASK_HEADERS,
  DEFAULT_MASK_QUERY_PARAMS,
  getConfig,
  matchesAny,
} from "./config.js";

export const REDACTED = "[REDACTED]";

// Location headers can contain secret query values, so redaction targets only
// their query parameters.
const URL_HEADER_NAMES = new Set(["location", "content-location"]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class Redaction {
  private queryParamPatterns: RegExp[];
  private headerPatterns: RegExp[];
  private bodyFieldPatterns: RegExp[];

  constructor() {
    const config = getConfig();
    this.queryParamPatterns = compilePatterns(DEFAULT_MASK_QUERY_PARAMS, config.maskQueryParams);
    this.headerPatterns = compilePatterns(DEFAULT_MASK_HEADERS, config.maskHeaders);
    this.bodyFieldPatterns = compilePatterns(DEFAULT_MASK_BODY_FIELDS, config.maskBodyFields);
  }

  // Redacts matching parameter names in a path with a query, a full URL, or a
  // bare query string when `assumeQuery` is true.
  redactQueryParams(value: string, assumeQuery = true): string {
    const separatorIndex = value.indexOf("?");
    if (separatorIndex === -1 && !assumeQuery) {
      return value;
    }
    const base = separatorIndex === -1 ? "" : value.slice(0, separatorIndex);
    const query = separatorIndex === -1 ? value : value.slice(separatorIndex + 1);
    const redactedParams = new URLSearchParams();
    for (const [name, paramValue] of new URLSearchParams(query)) {
      redactedParams.append(name, this.shouldRedactQueryParam(name) ? REDACTED : paramValue);
    }
    return separatorIndex === -1
      ? redactedParams.toString()
      : `${base}?${redactedParams.toString()}`;
  }

  redactHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
      result[name] = this.redactHeaderValue(name, value);
    }
    return result;
  }

  redactHeaderValue(name: string, value: string | string[]): string | string[];
  redactHeaderValue(name: string, value: unknown): unknown;
  redactHeaderValue(name: string, value: unknown): unknown {
    if (this.shouldRedactHeader(name)) {
      return Array.isArray(value) ? [REDACTED] : REDACTED;
    }
    if (!URL_HEADER_NAMES.has(name.toLowerCase())) {
      return value;
    }
    if (typeof value === "string") {
      return this.redactQueryParams(value, false);
    }
    if (Array.isArray(value)) {
      return value.map((item) =>
        typeof item === "string" ? this.redactQueryParams(item, false) : item,
      );
    }
    return value;
  }

  // Whether a body is JSON is decided by a parse attempt, never by content type.
  redactBody(body: Buffer): string | Buffer {
    let text: string;
    try {
      text = utf8Decoder.decode(body);
    } catch {
      return body;
    }
    let data: JsonValue;
    try {
      data = JSON.parse(text);
    } catch {
      return text;
    }
    return JSON.stringify(this.redactBodyFields(data));
  }

  private shouldRedactHeader(name: string): boolean {
    // OpenTelemetry HTTP header attributes normalize hyphens to underscores.
    return (
      matchesAny(this.headerPatterns, name) ||
      matchesAny(this.headerPatterns, name.replaceAll("_", "-"))
    );
  }

  private shouldRedactQueryParam(name: string): boolean {
    return matchesAny(this.queryParamPatterns, name);
  }

  private shouldRedactBodyField(name: string): boolean {
    return matchesAny(this.bodyFieldPatterns, name);
  }

  private redactBodyFields(data: JsonValue): JsonValue {
    if (Array.isArray(data)) {
      return data.map((item) => this.redactBodyFields(item));
    }
    if (typeof data === "object" && data !== null) {
      return Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          typeof value === "string" && this.shouldRedactBodyField(key)
            ? REDACTED
            : this.redactBodyFields(value),
        ]),
      );
    }
    return data;
  }
}
