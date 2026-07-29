import { createRequire } from "node:module";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { logDebug, logWarning } from "./logger.js";
import { getDistroVersion } from "./providers.js";
import type { Spool, SpoolFile } from "./spool.js";

const MAX_SENDS_PER_CYCLE = 10;
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

// Send cycles are serialized; a flush request joins the active cycle instead of
// posting files twice.
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
  private proxyTransport?: ProxyTransport;
  private readonly warnedStatuses = new Set<number>();
  private currentCycle?: Promise<void>;
  private currentCycleController?: AbortController;
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
    this.initialExportDelayMillis = options.initialExportDelayMillis ?? INITIAL_EXPORT_DELAY_MILLIS;
    this.requestTimeoutMillis = options.requestTimeoutMillis ?? REQUEST_TIMEOUT_MILLIS;
    this.interSendPauseMillis = options.interSendPauseMillis ?? (() => 100 + Math.random() * 400);
    const env = process.env;
    this.useProxy = Boolean(env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.scheduleNextExportCycle(this.initialExportDelayMillis);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.waitForIdle();
    if (this.proxyTransport) {
      await this.proxyTransport.dispatcher.close();
    }
  }

  // Runs one send cycle, or joins the cycle already running (no file posts twice).
  runCycle(): Promise<void> {
    return this.currentCycle ?? this.chainCycle(false);
  }

  // Closes current files and sends everything pending, optionally within one deadline.
  async finalDrain(timeoutMillis?: number): Promise<void> {
    if (timeoutMillis === undefined) {
      await this.chainCycle(true);
      return;
    }

    const deadlineController = new AbortController();
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadlineReached = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(() => {
        deadlineController.abort();
        resolve();
      }, timeoutMillis);
    });

    this.currentCycleController?.abort();
    const cycle = this.chainCycle(true, deadlineController.signal);
    try {
      await Promise.race([cycle, deadlineReached]);
    } finally {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
      }
    }
  }

  waitForIdle(): Promise<void> {
    return this.currentCycle ?? Promise.resolve();
  }

  private chainCycle(final: boolean, deadlineSignal?: AbortSignal): Promise<void> {
    const previous = this.currentCycle ?? Promise.resolve();
    const controller = new AbortController();
    const signal = deadlineSignal
      ? AbortSignal.any([controller.signal, deadlineSignal])
      : controller.signal;
    const cycle = previous
      .then(() => this.executeCycle(final, signal))
      .finally(() => {
        if (this.currentCycle === cycle) {
          this.currentCycle = undefined;
          this.currentCycleController = undefined;
        }
      });
    this.currentCycle = cycle;
    this.currentCycleController = controller;
    return cycle;
  }

  private async executeCycle(final: boolean, signal: AbortSignal): Promise<void> {
    try {
      // Suppress instrumentation so worker flushes and POSTs generate no telemetry.
      await context.with(suppressTracing(context.active()), async () => {
        for (const callback of this.flushCallbacks) {
          if (signal.aborted) {
            return;
          }
          await callback();
        }
        if (signal.aborted) {
          return;
        }
        if (final) {
          await this.spool.closeCurrentFiles();
        } else {
          await this.spool.rotateForExport();
          this.spool.touchFiles();
        }
        if (signal.aborted) {
          return;
        }
        await this.sendPendingFiles(final, signal);
      });
    } catch (error) {
      logDebug(`Error in Apitally export cycle: ${String(error)}`);
    }
  }

  // During an outage, stopping on failure limits each cycle to one probe POST.
  private async sendPendingFiles(final: boolean, signal: AbortSignal): Promise<void> {
    let sent = 0;
    for (const file of this.spool.pendingFiles()) {
      if (signal.aborted || (!final && sent >= MAX_SENDS_PER_CYCLE)) {
        return;
      }
      if (!final && sent > 0) {
        const pauseMillis = this.interSendPauseMillis();
        if (pauseMillis > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, pauseMillis).unref());
        }
        if (signal.aborted) {
          return;
        }
      }
      const expirationDeletion = this.spool.deleteIfExpired(file);
      if (expirationDeletion) {
        await expirationDeletion;
        continue;
      }
      sent += 1;
      if (!(await this.sendFile(file, signal))) {
        return;
      }
    }
  }

  // Sends the file's stored bytes verbatim. Returns false on a retryable
  // failure, which ends the cycle and keeps the file queued.
  private async sendFile(file: SpoolFile, signal: AbortSignal): Promise<boolean> {
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
    if (signal.aborted) {
      return false;
    }
    let response: Response;
    try {
      try {
        response = await this.postFile(url, body, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error) || isTimeoutError(error)) {
          throw error;
        }
        // The server may close an idle keep-alive connection mid-request; retry once.
        response = await this.postFile(url, body, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        logDebug(
          `Sending buffered ${file.signal} to Apitally failed (${String(error)}), will retry`,
        );
      }
      return false;
    }
    await response.arrayBuffer().catch(() => undefined);
    if (signal.aborted) {
      return false;
    }
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
        `Apitally rejected buffered ${file.signal} with HTTP ${response.status}; they were dropped`,
      );
    }
    await this.spool.deleteFile(file);
    return true;
  }

  private postFile(url: string, body: Buffer, signal: AbortSignal): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers: this.headers,
      body: body as unknown as BodyInit,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMillis)]),
    };
    if (!this.useProxy) {
      return fetch(url, init);
    }
    const transport = this.getProxyTransport();
    return transport.fetch(url, {
      ...init,
      dispatcher: transport.dispatcher,
    } as RequestInit);
  }

  private getProxyTransport(): ProxyTransport {
    if (!this.proxyTransport) {
      // undici's fetch is required because Node's bundled fetch does not accept
      // an undici dispatcher on every supported Node version.
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
      Math.min(Math.max(seconds, MIN_EXPORT_INTERVAL_SECONDS), MAX_EXPORT_INTERVAL_SECONDS) * 1000;
  }

  private scheduleNextExportCycle(delayMillis: number): void {
    this.timer = setTimeout(() => {
      void this.runCycle()
        .catch((error) => logDebug(`Error in Apitally export cycle: ${String(error)}`))
        .finally(() => {
          if (this.started) {
            // Jitter desynchronizes deployments whose processes started together.
            this.scheduleNextExportCycle(this.intervalMillis * (0.9 + Math.random() * 0.2));
          }
        });
    }, delayMillis);
    this.timer.unref();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
