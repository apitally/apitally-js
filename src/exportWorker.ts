import { createRequire } from "node:module";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { logDebug, logWarning } from "./logger.js";
import { getDistroVersion } from "./providers.js";
import type { Spool, SpoolFile } from "./spool.js";

export const MAX_SENDS_PER_CYCLE = 10;
const DEFAULT_EXPORT_INTERVAL_MILLIS = 15_000;
const EXPORT_INTERVAL_HEADER = "Apitally-Export-Interval";
const INITIAL_EXPORT_DELAY_MILLIS = 2_000;
const MIN_EXPORT_INTERVAL_SECONDS = 5;
const MAX_EXPORT_INTERVAL_SECONDS = 60;
const REQUEST_TIMEOUT_MILLIS = 10_000;
const RETRYABLE_STATUS_CODES = new Set([408, 429]);

export type FlushCallback = () => Promise<void> | void;

export interface ExportWorkerOptions {
  spool: Spool;
  otlpEndpoint: string;
  writeToken: string;
  env: string;
  initialExportDelayMillis?: number;
  requestTimeoutMillis?: number;
  interSendPauseMillis?: () => number;
}

interface ProxyTransport {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  dispatcher: { close(): Promise<void> };
}

// Sends spool files to the OTLP endpoint every export interval. Cycles are
// serialized on one timer chain; a flush request arriving mid-cycle awaits the
// running cycle instead of starting a second one.
export class ExportWorker {
  // Invoked at the start of every cycle, before files are rotated and sent.
  readonly flushCallbacks: FlushCallback[] = [];
  intervalMillis = DEFAULT_EXPORT_INTERVAL_MILLIS;
  private readonly spool: Spool;
  private readonly otlpEndpoint: string;
  private readonly headers: Record<string, string>;
  private readonly initialExportDelayMillis: number;
  private readonly requestTimeoutMillis: number;
  private readonly interSendPauseMillis: () => number;
  private readonly useProxy: boolean;
  private readonly runtimeIsBun: boolean;
  private readonly bunProxyUrl?: string;
  private proxyTransport?: ProxyTransport;
  private readonly warnedStatuses = new Set<number>();
  private currentCycle?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private started = false;

  constructor(options: ExportWorkerOptions) {
    this.spool = options.spool;
    this.otlpEndpoint = options.otlpEndpoint;
    this.headers = {
      Authorization: `Bearer ${options.writeToken}`,
      "Apitally-Env": options.env,
      "Content-Type": "application/x-protobuf",
      "Content-Encoding": "gzip",
      "User-Agent": `apitally-js/${getDistroVersion()}`,
    };
    this.initialExportDelayMillis =
      options.initialExportDelayMillis ?? INITIAL_EXPORT_DELAY_MILLIS;
    this.requestTimeoutMillis =
      options.requestTimeoutMillis ?? REQUEST_TIMEOUT_MILLIS;
    this.interSendPauseMillis =
      options.interSendPauseMillis ?? (() => 100 + Math.random() * 400);
    const env = process.env;
    this.useProxy = Boolean(
      env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy,
    );
    this.runtimeIsBun = "Bun" in globalThis;
    if (
      this.useProxy &&
      this.runtimeIsBun &&
      !shouldBypassProxy(this.otlpEndpoint)
    ) {
      this.bunProxyUrl = this.otlpEndpoint.startsWith("https:")
        ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
        : env.HTTP_PROXY || env.http_proxy;
    }
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.armTimer(this.initialExportDelayMillis);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.currentCycle) {
      await this.currentCycle;
    }
    if (this.proxyTransport) {
      await this.proxyTransport.dispatcher.close();
    }
  }

  // Runs one send cycle, or joins the cycle already running (no file posts twice).
  runCycle(): Promise<void> {
    return this.currentCycle ?? this.chainCycle(false);
  }

  // One uncapped, unpaced cycle that closes all current files and sends everything pending.
  async finalDrain(): Promise<void> {
    await this.chainCycle(true);
  }

  private chainCycle(final: boolean): Promise<void> {
    const previous = this.currentCycle ?? Promise.resolve();
    const cycle = previous
      .then(() => this.executeCycle(final))
      .finally(() => {
        if (this.currentCycle === cycle) {
          this.currentCycle = undefined;
        }
      });
    this.currentCycle = cycle;
    return cycle;
  }

  private async executeCycle(final: boolean): Promise<void> {
    try {
      // Suppress instrumentation so the worker's flushes and POSTs generate no telemetry
      await context.with(suppressTracing(context.active()), async () => {
        for (const callback of this.flushCallbacks) {
          await callback();
        }
        if (final) {
          await this.spool.closeCurrentFiles();
        } else {
          await this.spool.rotateForExport();
          this.spool.touchFiles();
        }
        await this.sendPendingFiles(final);
      });
    } catch (error) {
      logDebug(`Error in Apitally export cycle: ${String(error)}`);
    }
  }

  // During an outage the stop-on-failure rule below amounts to one probe POST per cycle.
  private async sendPendingFiles(final: boolean): Promise<void> {
    let sent = 0;
    for (const file of this.spool.pendingFiles()) {
      if (!final && sent >= MAX_SENDS_PER_CYCLE) {
        return;
      }
      if (!final && sent > 0) {
        await sleep(this.interSendPauseMillis());
      }
      if (file.isExpired()) {
        // A retry landing outside the server's dedup window could double-ingest
        logWarning(
          `Buffered ${file.signal} could not be delivered within an hour and were dropped`,
        );
        await this.spool.deleteFile(file);
        continue;
      }
      sent += 1;
      if (!(await this.sendFile(file))) {
        return;
      }
    }
  }

  // Sends the file's stored bytes verbatim. Returns false on a retryable
  // failure, which ends the cycle and keeps the file queued.
  private async sendFile(file: SpoolFile): Promise<boolean> {
    file.markAttempt();
    const url = `${this.otlpEndpoint}/v1/${file.signal}`;
    let body: Buffer;
    try {
      body = await file.readStoredBytes();
    } catch {
      logWarning(`Error reading buffered ${file.signal}, dropping the file`);
      await this.spool.deleteFile(file);
      return true;
    }
    let response: Response;
    try {
      try {
        response = await this.postFile(url, body);
      } catch (error) {
        if (isTimeoutError(error)) {
          throw error;
        }
        // The server may close an idle keep-alive connection mid-request; retry once
        response = await this.postFile(url, body);
      }
    } catch (error) {
      logDebug(
        `Sending buffered ${file.signal} to Apitally failed (${String(error)}), will retry`,
      );
      return false;
    }
    await response.arrayBuffer().catch(() => undefined);
    this.applyIntervalHeader(response);
    if (response.status >= 200 && response.status < 300) {
      await this.spool.deleteFile(file);
      return true;
    }
    if (RETRYABLE_STATUS_CODES.has(response.status) || response.status >= 500) {
      logDebug(
        `Sending buffered ${file.signal} to Apitally failed with HTTP ${response.status}, will retry`,
      );
      return false;
    }
    if (!this.warnedStatuses.has(response.status)) {
      this.warnedStatuses.add(response.status);
      logWarning(
        `Apitally rejected buffered ${file.signal} with HTTP ${response.status}, dropping it`,
      );
    }
    await this.spool.deleteFile(file);
    return true;
  }

  private postFile(url: string, body: Buffer): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers: this.headers,
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(this.requestTimeoutMillis),
    };
    if (!this.useProxy) {
      return fetch(url, init);
    }
    if (this.runtimeIsBun) {
      return fetch(url, { ...init, proxy: this.bunProxyUrl } as RequestInit);
    }
    const transport = this.getProxyTransport();
    return transport.fetch(url, {
      ...init,
      dispatcher: transport.dispatcher,
    } as RequestInit);
  }

  private getProxyTransport(): ProxyTransport {
    if (!this.proxyTransport) {
      // undici's fetch is required alongside the agent: a dispatcher from the
      // undici package is not accepted by the Node-bundled fetch on all Node versions
      const undici = createRequire(import.meta.url)("undici") as {
        fetch: ProxyTransport["fetch"];
        EnvHttpProxyAgent: new () => ProxyTransport["dispatcher"];
      };
      this.proxyTransport = {
        fetch: undici.fetch,
        dispatcher: new undici.EnvHttpProxyAgent(),
      };
    }
    return this.proxyTransport;
  }

  private applyIntervalHeader(response: Response): void {
    const value = response.headers.get(EXPORT_INTERVAL_HEADER);
    if (!value) {
      return;
    }
    const seconds = Number.parseInt(value, 10);
    if (Number.isNaN(seconds)) {
      return;
    }
    this.intervalMillis =
      Math.min(
        Math.max(seconds, MIN_EXPORT_INTERVAL_SECONDS),
        MAX_EXPORT_INTERVAL_SECONDS,
      ) * 1000;
  }

  private armTimer(delayMillis: number): void {
    this.timer = setTimeout(() => {
      void this.runCycle()
        .catch((error) =>
          logDebug(`Error in Apitally export cycle: ${String(error)}`),
        )
        .finally(() => {
          if (this.started) {
            // Jitter desynchronizes deployments whose processes started together
            this.armTimer(this.intervalMillis * (0.9 + Math.random() * 0.2));
          }
        });
    }, delayMillis);
    this.timer.unref();
  }
}

// Bun's per-request proxy option ignores NO_PROXY, so the endpoint is tested
// here, mirroring how undici's EnvHttpProxyAgent on the Node path interprets
// the variable: entries split on commas and whitespace, optional :port suffix,
// exact host match, and suffix match for entries starting with "." or "*".
function shouldBypassProxy(endpoint: string): boolean {
  const noProxy = process.env.no_proxy ?? process.env.NO_PROXY;
  if (!noProxy) {
    return false;
  }
  if (noProxy === "*") {
    return true;
  }
  const url = new URL(endpoint);
  const hostname = url.host.replace(/:\d*$/, "").toLowerCase();
  const port =
    Number.parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80);
  for (const rawEntry of noProxy.split(/[,\s]/)) {
    if (!rawEntry) {
      continue;
    }
    const parsed = rawEntry.match(/^(.+):(\d+)$/);
    const entryHostname = (parsed ? parsed[1] : rawEntry).toLowerCase();
    const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0;
    if (entryPort && entryPort !== port) {
      continue;
    }
    if (/^[.*]/.test(entryHostname)) {
      if (hostname.endsWith(entryHostname.replace(/^\*/, ""))) {
        return true;
      }
    } else if (hostname === entryHostname) {
      return true;
    }
  }
  return false;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function sleep(millis: number): Promise<void> {
  if (millis <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, millis).unref());
}
