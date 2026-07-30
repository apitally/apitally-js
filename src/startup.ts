import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";
import { getConfig } from "./config.js";
import { logDebug } from "./logger.js";

export interface RoutePath {
  method: string;
  path: string;
}

export interface StartupEventInfo {
  framework: string;
  frameworkVersion?: string;
  // Resolved at emission because routes often finalize after setup.
  resolvePaths: () => RoutePath[];
}

let startupEventEmitted = false;

// The startup event emits at most once. Route resolution or serialization
// failures emit the remaining valid data and never reach the application.
export function emitStartupEvent(loggerProvider: LoggerProvider, info: StartupEventInfo): void {
  if (startupEventEmitted) {
    return;
  }
  startupEventEmitted = true;
  const versions: Record<string, string> = { node: process.versions.node };
  if (info.frameworkVersion) {
    versions[info.framework] = info.frameworkVersion;
  }
  const appVersion = getConfig().appVersion;
  if (appVersion) {
    versions.app = appVersion;
  }
  let paths: RoutePath[] | undefined;
  try {
    paths = normalizeStartupPaths(info.resolvePaths());
  } catch (error) {
    logDebug(`Error resolving the app's routes for the startup event: ${String(error)}`);
  }
  const body =
    serializePayload({ framework: info.framework, versions, paths }) ??
    (paths !== undefined ? serializePayload({ framework: info.framework, versions }) : undefined);
  if (body === undefined) {
    return;
  }
  loggerProvider.getLogger("apitally").emit({
    timestamp: Date.now(),
    // The explicit root context keeps the record separate from the request
    // whose handling triggered the emit.
    context: ROOT_CONTEXT,
    eventName: "apitally.app.startup",
    body,
  });
}

export function resetStartupEventEmitted(): void {
  startupEventEmitted = false;
}

function normalizeStartupPaths(candidates: RoutePath[]): RoutePath[] {
  const paths: RoutePath[] = [];
  const seenPaths = new Set<string>();
  for (const candidate of candidates) {
    const method = candidate.method.toUpperCase();
    if (method === "ALL" || method === "HEAD" || method === "OPTIONS") {
      continue;
    }
    const key = `${method}\0${candidate.path}`;
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      paths.push({ ...candidate, method });
    }
  }
  return paths;
}

function serializePayload(payload: {
  framework: string;
  versions: Record<string, string>;
  paths?: RoutePath[];
}): string | undefined {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    logDebug(`Error serializing the startup event payload: ${String(error)}`);
    return undefined;
  }
}
