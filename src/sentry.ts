import { createRequire } from "node:module";
import { getRequestRecord, getServerSpan } from "./context.js";
import { peerResolver } from "./logCapture.js";
import { logDebug } from "./logger.js";
import { writeRequestAttribute } from "./spanProcessor.js";

// Minimal structural types: @sentry/node is an optional peer that is resolved
// at runtime and never imported.
interface SentryEvent {
  event_id?: string;
  exception?: { values?: unknown[] };
}

interface SentryClient {
  on(hook: "beforeSendEvent", callback: (event: SentryEvent) => void): unknown;
}

// An initialized Sentry client opts in to linking exception event IDs with
// active SERVER spans. Calls outside a request are no-ops.
export function installSentryEventIdLinkage(): void {
  try {
    const client =
      getClientThroughPeerResolution() ?? getClientFromGlobalCarrier();
    if (!client) {
      logDebug("No Sentry client was detected");
      return;
    }
    client.on("beforeSendEvent", (event) => {
      try {
        if (
          typeof event.event_id !== "string" ||
          !event.exception?.values?.length
        ) {
          return;
        }
        writeRequestAttribute(
          getServerSpan(),
          getRequestRecord(),
          "apitally.exception.sentry_event_id",
          event.event_id,
        );
      } catch (error) {
        logDebug(`Error writing the Sentry event id: ${String(error)}`);
      }
    });
  } catch (error) {
    logDebug(`Error setting up the Sentry integration: ${String(error)}`);
  }
}

// getClient() resolves wherever @sentry/node is reachable, including as the
// transitive dependency of a Sentry wrapper package on npm-style layouts.
function getClientThroughPeerResolution(): SentryClient | undefined {
  try {
    const entryPath = peerResolver.resolveEntryPath("@sentry/node");
    const sentry = createRequire(entryPath)(entryPath) as {
      getClient?: () => unknown;
    };
    return typeof sentry.getClient === "function"
      ? asSentryClient(sentry.getClient())
      : undefined;
  } catch {
    return undefined;
  }
}

// Strict package layouts may prevent peer resolution. Sentry 7 to 10 still
// expose initialized clients through two globalThis carrier shapes.
function getClientFromGlobalCarrier(): SentryClient | undefined {
  const carrier = (globalThis as { __SENTRY__?: unknown }).__SENTRY__;
  if (!isRecord(carrier)) {
    return undefined;
  }
  const hub = carrier.hub;
  if (isRecord(hub) && typeof hub.getClient === "function") {
    return asSentryClient(hub.getClient());
  }
  const versioned =
    typeof carrier.version === "string" ? carrier[carrier.version] : undefined;
  if (!isRecord(versioned)) {
    return undefined;
  }
  const acs = versioned.acs;
  if (isRecord(acs) && typeof acs.getCurrentScope === "function") {
    const scope: unknown = acs.getCurrentScope();
    if (isRecord(scope) && typeof scope.getClient === "function") {
      const client = asSentryClient(scope.getClient());
      if (client) {
        return client;
      }
    }
  }
  const defaultScope = versioned.defaultCurrentScope;
  if (isRecord(defaultScope) && typeof defaultScope.getClient === "function") {
    return asSentryClient(defaultScope.getClient());
  }
  return undefined;
}

function asSentryClient(value: unknown): SentryClient | undefined {
  return isRecord(value) && typeof value.on === "function"
    ? (value as unknown as SentryClient)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
