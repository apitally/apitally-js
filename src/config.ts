import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { logError, logWarning } from "./logger.js";

export type BodyMaskingCallback = (body: Buffer, span: ReadableSpan) => Buffer | null;
export type SamplingCallback = (span: ReadableSpan) => number | boolean | undefined;

export interface ApitallyOptions {
  writeToken?: string;
  env?: string;
  appVersion?: string;
  disabled?: boolean;
  captureLogs?: boolean;
  captureRequestHeaders?: boolean;
  captureRequestBody?: boolean;
  captureResponseHeaders?: boolean;
  captureResponseBody?: boolean;
  maskQueryParams?: string[];
  maskHeaders?: string[];
  maskBodyFields?: string[];
  maskRequestBody?: BodyMaskingCallback;
  maskResponseBody?: BodyMaskingCallback;
  excludePaths?: string[];
  sampleRate?: number;
  sampleOnRequest?: SamplingCallback;
  sampleOnResponse?: SamplingCallback;
}

type OptionalConfigKeys =
  | "appVersion"
  | "maskRequestBody"
  | "maskResponseBody"
  | "sampleOnRequest"
  | "sampleOnResponse";

export type ApitallyConfig = Required<Omit<ApitallyOptions, OptionalConfigKeys>> &
  Pick<ApitallyOptions, OptionalConfigKeys> & { otlpEndpoint: string };

const DEFAULT_OTLP_ENDPOINT = "https://otlp.apitally.io";
export const DEFAULT_ENV = "dev";

// User-supplied patterns extend these defaults, never replace them.
export const DEFAULT_MASK_QUERY_PARAMS = ["auth", "api-?key", "secret", "token", "password", "pwd"];
export const DEFAULT_MASK_HEADERS = ["auth", "api-?key", "secret", "token", "cookie"];
export const DEFAULT_MASK_BODY_FIELDS = [
  "password",
  "pwd",
  "token",
  "secret",
  "auth",
  "card[-_ ]?number",
  "ccv",
  "ssn",
];
export const DEFAULT_EXCLUDE_PATHS = [
  "/_?healthz?$",
  "/_?health[-_]?checks?$",
  "/_?heart[-_]?beats?$",
  "/ping$",
  "/ready$",
  "/live$",
  "/favicon(?:-[\\w-]+)?\\.(ico|png|svg)$",
  "/apple-touch-icon(?:-[\\w-]+)?\\.png$",
  "/robots\\.txt$",
  "/sitemap\\.xml$",
  "/manifest\\.json$",
  "/site\\.webmanifest$",
  "/service-worker\\.js$",
  "/sw\\.js$",
  "/\\.well-known/",
];
export const EXCLUDE_USER_AGENTS = [
  "health[-_ ]?check",
  "microsoft-azure-application-lb",
  "googlehc",
  "kube-probe",
];

const WRITE_TOKEN_FORMAT = /^apt_[a-zA-Z0-9]{24}$/;
const TRUE_VALUES = new Set(["1", "true", "yes"]);

// The ESM and CJS builds can load together, so a Symbol.for key gives both
// copies the same configuration.
const GLOBAL_CONFIG_KEY = Symbol.for("apitally.config");
const configHolder = globalThis as Record<symbol, ApitallyConfig | undefined>;

export function setConfig(options: ApitallyOptions = {}): ApitallyConfig {
  const { config, error } = resolveConfig(options);
  const currentConfig = configHolder[GLOBAL_CONFIG_KEY];
  if (currentConfig) {
    if (!isSameConfig(config, currentConfig)) {
      logWarning(
        "useApitally() was called again with different options; the first call's configuration stays in effect",
      );
    }
    return currentConfig;
  }
  if (error) {
    logError(error);
  }
  configHolder[GLOBAL_CONFIG_KEY] = config;
  return config;
}

export function getConfig(): ApitallyConfig {
  return configHolder[GLOBAL_CONFIG_KEY] ?? resolveConfig({}).config;
}

export function isValidWriteToken(value: string): boolean {
  return WRITE_TOKEN_FORMAT.test(value);
}

// The emergency kill switch, re-checked at the activation boundary so it wins
// even over an explicit disabled: false option.
export function isApitallyDisabledViaEnv(): boolean {
  return isTruthyEnvValue(process.env.APITALLY_DISABLED);
}

export function matchesAny(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function compilePatterns(defaults: string[], userPatterns: string[] = []): RegExp[] {
  return [...defaults, ...userPatterns].map((pattern) => new RegExp(pattern, "i"));
}

function resolveConfig(options: ApitallyOptions): {
  config: ApitallyConfig;
  error?: string;
} {
  const config: ApitallyConfig = {
    writeToken: options.writeToken ?? nonEmptyEnvVar("APITALLY_WRITE_TOKEN") ?? "",
    env: options.env ?? nonEmptyEnvVar("APITALLY_ENV") ?? DEFAULT_ENV,
    appVersion: options.appVersion,
    disabled:
      options.disabled ??
      (isTruthyEnvValue(process.env.APITALLY_DISABLED) ||
        isTruthyEnvValue(process.env.OTEL_SDK_DISABLED)),
    captureLogs: options.captureLogs ?? true,
    captureRequestHeaders: options.captureRequestHeaders ?? false,
    captureRequestBody: options.captureRequestBody ?? false,
    captureResponseHeaders: options.captureResponseHeaders ?? true,
    captureResponseBody: options.captureResponseBody ?? false,
    maskQueryParams: dropInvalidPatterns("maskQueryParams", options.maskQueryParams),
    maskHeaders: dropInvalidPatterns("maskHeaders", options.maskHeaders),
    maskBodyFields: dropInvalidPatterns("maskBodyFields", options.maskBodyFields),
    maskRequestBody: options.maskRequestBody,
    maskResponseBody: options.maskResponseBody,
    excludePaths: dropInvalidPatterns("excludePaths", options.excludePaths),
    // An invalid sampleRate resolves to capturing everything: no data is lost, so no warning.
    sampleRate:
      typeof options.sampleRate === "number" && options.sampleRate >= 0 && options.sampleRate <= 1
        ? options.sampleRate
        : 1,
    sampleOnRequest: options.sampleOnRequest,
    sampleOnResponse: options.sampleOnResponse,
    otlpEndpoint: nonEmptyEnvVar("APITALLY_OTLP_ENDPOINT") ?? DEFAULT_OTLP_ENDPOINT,
  };
  if (config.disabled) {
    return { config };
  }
  if (!config.writeToken) {
    config.disabled = true;
    return {
      config,
      error:
        "Apitally write token is missing (set the writeToken option or the APITALLY_WRITE_TOKEN environment variable)",
    };
  }
  if (!isValidWriteToken(config.writeToken)) {
    config.disabled = true;
    // The write token is a credential and must never appear unmasked in logs.
    return {
      config,
      error: `Apitally write token has an invalid format: ${config.writeToken.slice(0, 8)}...`,
    };
  }
  if (!isHttpUrl(config.otlpEndpoint)) {
    config.disabled = true;
    return {
      config,
      error: `Apitally OTLP endpoint is not a valid HTTP or HTTPS URL: ${config.otlpEndpoint}`,
    };
  }
  return { config };
}

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

// An invalid pattern without an error could leave data unredacted, so invalid
// patterns are logged and omitted.
function dropInvalidPatterns(optionName: string, patterns: string[] = []): string[] {
  return patterns.filter((pattern) => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      logError(`Invalid regular expression pattern in ${optionName} ignored: ${pattern}`);
      return false;
    }
  });
}

function isSameConfig(a: ApitallyConfig, b: ApitallyConfig): boolean {
  return (Object.keys(a) as (keyof ApitallyConfig)[]).every((key) => {
    const left = a[key];
    const right = b[key];
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((item, index) => item === right[index]);
    }
    return left === right;
  });
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

function nonEmptyEnvVar(name: string): string | undefined {
  return process.env[name] || undefined;
}
