import {
  compilePatterns,
  DEFAULT_MASK_BODY_FIELDS,
  DEFAULT_MASK_HEADERS,
  DEFAULT_MASK_QUERY_PARAMS,
  getConfig,
  matchesAny,
} from "./config.js";

export const REDACTED = "[REDACTED]";

// Headers whose values are URLs and get query redaction instead of masking
export const URL_HEADER_NAMES = new Set(["location", "content-location"]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class Redaction {
  private queryParamPatterns: RegExp[];
  private headerPatterns: RegExp[];
  private bodyFieldPatterns: RegExp[];

  constructor() {
    const config = getConfig();
    this.queryParamPatterns = compilePatterns(
      DEFAULT_MASK_QUERY_PARAMS,
      config.maskQueryParams,
    );
    this.headerPatterns = compilePatterns(
      DEFAULT_MASK_HEADERS,
      config.maskHeaders,
    );
    this.bodyFieldPatterns = compilePatterns(
      DEFAULT_MASK_BODY_FIELDS,
      config.maskBodyFields,
    );
  }

  // Redacts matching param names in a path?query target, a full URL, or (with
  // assumeQuery) a bare query string.
  redactQueryParams(value: string, assumeQuery = true): string {
    const separatorIndex = value.indexOf("?");
    if (separatorIndex === -1 && !assumeQuery) {
      return value;
    }
    const base = separatorIndex === -1 ? "" : value.slice(0, separatorIndex);
    const query =
      separatorIndex === -1 ? value : value.slice(separatorIndex + 1);
    const redactedParams = new URLSearchParams();
    for (const [name, paramValue] of new URLSearchParams(query)) {
      redactedParams.append(
        name,
        this.shouldRedactQueryParam(name) ? REDACTED : paramValue,
      );
    }
    return separatorIndex === -1
      ? redactedParams.toString()
      : `${base}?${redactedParams.toString()}`;
  }

  redactHeaders(
    headers: Record<string, string | string[]>,
  ): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (this.shouldRedactHeader(name)) {
        result[name] = typeof value === "string" ? REDACTED : [REDACTED];
      } else if (URL_HEADER_NAMES.has(name.toLowerCase())) {
        result[name] =
          typeof value === "string"
            ? this.redactQueryParams(value, false)
            : value.map((item) => this.redactQueryParams(item, false));
      } else {
        result[name] = value;
      }
    }
    return result;
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

  shouldRedactHeader(name: string): boolean {
    // Also match the underscore-normalized attribute key form emitted by older instrumentations
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
