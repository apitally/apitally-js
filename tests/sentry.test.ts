import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it } from "vitest";
import { peerResolver } from "../src/logCapture.js";
import { installSentryEventIdRecording } from "../src/sentry.js";
import {
  captureStderr,
  createTracePipeline,
  enableAsyncContextManager,
  runInsideRequest,
  type TracePipeline,
} from "./utils.js";

function initSentryClient(): Sentry.NodeClient {
  const client =
    Sentry.init({
      dsn: "https://a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@example.com/1",
      transport: () => ({
        send: () => Promise.resolve({}),
        flush: () => Promise.resolve(true),
      }),
      defaultIntegrations: false,
      skipOpenTelemetrySetup: true,
    }) ?? getClientFromHub();
  if (!client) {
    throw new Error("Sentry did not initialize a client");
  }
  return client;
}

// Sentry 7's init() returns void; its client is reachable through the hub.
function getClientFromHub(): Sentry.NodeClient | undefined {
  const sentry = Sentry as unknown as {
    getCurrentHub?: () => { getClient(): Sentry.NodeClient | undefined };
  };
  return sentry.getCurrentHub?.().getClient();
}

function createSentryFixture(): {
  fixture: TracePipeline;
  client: Sentry.NodeClient;
} {
  enableAsyncContextManager();
  const fixture = createTracePipeline();
  const client = initSentryClient();
  return { fixture, client };
}

// Resolves once the next event has passed through the client's event pipeline,
// after the SDK's own subscriber ran.
function nextEventSent(client: Sentry.NodeClient): Promise<void> {
  return new Promise((resolve) => {
    client.on("beforeSendEvent", () => resolve());
  });
}

function setGlobalCarrier(carrier: unknown): void {
  (globalThis as { __SENTRY__?: unknown }).__SENTRY__ = carrier;
}

describe("sentry", () => {
  afterEach(async () => {
    await Sentry.close();
    delete (globalThis as { __SENTRY__?: unknown }).__SENTRY__;
  });

  it("writes a Sentry exception event's id onto the active SERVER span, ignoring non-exception events", async () => {
    const { fixture, client } = createSentryFixture();
    installSentryEventIdRecording();
    let eventId: string | undefined;
    const serverSpan = await runInsideRequest(fixture, async () => {
      const messageSent = nextEventSent(client);
      Sentry.captureMessage("checkpoint reached");
      await messageSent;
      const exceptionSent = nextEventSent(client);
      eventId = Sentry.captureException(new Error("boom"));
      await exceptionSent;
    });
    expect(eventId).toBeTypeOf("string");
    expect(serverSpan.attributes).toEqual({
      "apitally.exception.sentry_event_id": eventId,
    });
  });

  it("detects the client through the global carrier when peer resolution fails", async () => {
    const { fixture, client } = createSentryFixture();
    peerResolver.resolveEntryPath = () => {
      throw new Error("Cannot find module '@sentry/node'");
    };
    installSentryEventIdRecording();
    let eventId: string | undefined;
    const serverSpan = await runInsideRequest(fixture, async () => {
      const exceptionSent = nextEventSent(client);
      eventId = Sentry.captureException(new Error("boom"));
      await exceptionSent;
    });
    expect(eventId).toBeTypeOf("string");
    expect(serverSpan.attributes).toEqual({
      "apitally.exception.sentry_event_id": eventId,
    });
  });

  it("does not throw or warn when Sentry is absent or the carrier is malformed", () => {
    const lines = captureStderr();
    process.env.APITALLY_DEBUG = "true";
    peerResolver.resolveEntryPath = () => {
      throw new Error("Cannot find module '@sentry/node'");
    };
    expect(() => installSentryEventIdRecording()).not.toThrow();
    setGlobalCarrier({});
    expect(() => installSentryEventIdRecording()).not.toThrow();
    setGlobalCarrier({ version: "10.0.0" });
    expect(() => installSentryEventIdRecording()).not.toThrow();
    expect(
      lines.filter((line) => !line.startsWith("[Apitally DEBUG]")),
    ).toEqual([]);
  });
});
