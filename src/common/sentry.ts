import type * as Sentry from "@sentry/node";

let sentry: typeof Sentry | undefined;

// Initialize Sentry when the module is loaded
(async () => {
  try {
    sentry = await import("@sentry/node");
  } catch (e) {
    // Sentry SDK is not installed, ignore
  }
})();

/**
 * Returns the last Sentry event ID if available
 */
export function getSentryEventId(): string | undefined {
  if (sentry && sentry.lastEventId) {
    return sentry.lastEventId();
  }
  return undefined;
}
