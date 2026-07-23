import { createRequire } from "node:module";
import { format } from "node:util";
import {
  type AnyValue,
  type Logger,
  type LoggerProvider,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import { logDebug } from "./logger.js";

// Patch markers are Symbol.for-keyed on the patched objects themselves, so a
// second install never double-wraps or double-attaches, even across SDK copies.
const CONSOLE_PATCH_MARKER = Symbol.for("apitally.consolePatch");
const WINSTON_PATCH_MARKER = Symbol.for("apitally.winstonPatch");
const WINSTON_TRANSPORT_MARKER = Symbol.for("apitally.winstonTransport");
const PINO_PATCH_MARKER = Symbol.for("apitally.pinoPatch");
const PINO_HOOK_MARKER = Symbol.for("apitally.pinoStreamWriteHook");

const CONSOLE_METHOD_SEVERITIES = {
  debug: SeverityNumber.DEBUG,
  log: SeverityNumber.INFO,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

// Union of winston's npm, syslog, and cli level vocabularies.
const WINSTON_LEVEL_SEVERITIES: Record<string, SeverityNumber> = {
  emerg: SeverityNumber.FATAL3,
  alert: SeverityNumber.FATAL2,
  crit: SeverityNumber.FATAL,
  error: SeverityNumber.ERROR,
  warn: SeverityNumber.WARN,
  warning: SeverityNumber.WARN,
  help: SeverityNumber.INFO3,
  notice: SeverityNumber.INFO2,
  data: SeverityNumber.INFO2,
  info: SeverityNumber.INFO,
  http: SeverityNumber.DEBUG3,
  verbose: SeverityNumber.DEBUG2,
  debug: SeverityNumber.DEBUG,
  prompt: SeverityNumber.TRACE4,
  input: SeverityNumber.TRACE2,
  silly: SeverityNumber.TRACE,
};

interface WinstonLoggerInstance {
  transports: object[];
  add(transport: object): unknown;
  remove(transport: object): unknown;
}

interface PinoStreamWriteHooks {
  streamWrite?: (line: string) => string;
}

type PinoModule = {
  (options: object, destination: { write: (line: string) => void }): object;
  symbols: Record<string, symbol | undefined>;
};

let restoreConsoleCapture: (() => void) | undefined;
let restoreWinstonCapture: (() => void) | undefined;
let restorePinoCapture: (() => void) | undefined;

// The console has no policy layer to respect; the method wrap is the seam. Each
// wrap calls the original first and never throws into the application.
export function installConsoleCapture(loggerProvider: LoggerProvider): void {
  if (hasPatchMarker(console, CONSOLE_PATCH_MARKER)) {
    return;
  }
  const logger = loggerProvider.getLogger("console");
  const restoreSteps: (() => void)[] = [];
  for (const [method, severityNumber] of Object.entries(
    CONSOLE_METHOD_SEVERITIES,
  ) as [keyof typeof CONSOLE_METHOD_SEVERITIES, SeverityNumber][]) {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      original.apply(console, args);
      emitCapturedLogRecord(logger, {
        severityNumber,
        severityText: method,
        body: format(...args),
      });
    };
    restoreSteps.push(() => {
      console[method] = original;
    });
  }
  setPatchMarker(console, CONSOLE_PATCH_MARKER);
  restoreConsoleCapture = () => {
    for (const restore of restoreSteps) {
      restore();
    }
    clearPatchMarker(console, CONSOLE_PATCH_MARKER);
  };
}

// Log data flows exclusively through winston's official transport contract, so
// silent, level thresholds, and formats apply before a record arrives here. The
// only patch is a write shadow that attaches the transport, never reading logs.
export function installWinstonCapture(loggerProvider: LoggerProvider): void {
  let createProbeLogger: () => object;
  let TransportBase: new () => object;
  try {
    const winstonEntryPath = peerResolver.resolveEntryPath("winston");
    const requireFromWinston = createRequire(winstonEntryPath);
    const winston = requireFromWinston(winstonEntryPath) as {
      createLogger: () => object;
    };
    createProbeLogger = winston.createLogger;
    // The transport base resolves relative to the winston entry, so both come
    // from the same installed copy under strict package layouts.
    TransportBase = requireFromWinston("winston-transport") as new () => object;
  } catch {
    // winston is not installed
    return;
  }
  // createLogger mints a per-call DerivedLogger subclass; the prototype shared
  // by every logger is the one owning configure.
  const loggerPrototype = findPrototypeOwning(createProbeLogger(), "configure");
  if (!loggerPrototype || typeof loggerPrototype.write !== "function") {
    logDebug("The winston logger prototype was not recognized");
    return;
  }
  if (hasPatchMarker(loggerPrototype, WINSTON_PATCH_MARKER)) {
    return;
  }
  const logger = loggerProvider.getLogger("winston");

  class ApitallyTransport extends TransportBase {
    readonly [WINSTON_TRANSPORT_MARKER] = true;

    log(
      info: { level?: unknown; message?: unknown },
      callback?: () => void,
    ): void {
      const severityText = typeof info.level === "string" ? info.level : "";
      emitCapturedLogRecord(logger, {
        severityNumber:
          WINSTON_LEVEL_SEVERITIES[severityText] ?? SeverityNumber.INFO,
        severityText,
        body: info.message as AnyValue,
      });
      callback?.();
    }
  }

  const attachedTransports = new Map<WinstonLoggerInstance, object>();
  const originalWrite = loggerPrototype.write as (
    ...args: unknown[]
  ) => boolean;
  // The shadow never reads the log entry: it only ensures the transport is
  // attached through the official add(), covering loggers created before the
  // patch and re-attaching after clear(), then delegates. winston buffers
  // entries on zero-transport loggers and the attach drains that backlog.
  loggerPrototype.write = function (
    this: WinstonLoggerInstance,
    ...args: unknown[]
  ): boolean {
    try {
      if (
        !this.transports.some((transport) =>
          hasPatchMarker(transport, WINSTON_TRANSPORT_MARKER),
        )
      ) {
        const transport = new ApitallyTransport();
        this.add(transport);
        attachedTransports.set(this, transport);
      }
    } catch {
      // An attach failure must never break the application's logging
    }
    return originalWrite.apply(this, args);
  };
  setPatchMarker(loggerPrototype, WINSTON_PATCH_MARKER);
  restoreWinstonCapture = () => {
    loggerPrototype.write = originalWrite;
    clearPatchMarker(loggerPrototype, WINSTON_PATCH_MARKER);
    for (const [winstonLogger, transport] of attachedTransports) {
      try {
        winstonLogger.remove(transport);
      } catch {
        // The logger may already have removed the transport itself
      }
    }
  };
}

// Capture reads the post-redaction, post-serializer line through pino's
// official streamWrite hook, so redact paths and serializers apply before the
// SDK sees a record. The write patch is a discovery point that never reads the
// log data: it retrofits the hook and stashes the level, then delegates.
export function installPinoCapture(loggerProvider: LoggerProvider): void {
  let pino: PinoModule;
  try {
    const pinoEntryPath = peerResolver.resolveEntryPath("pino");
    pino = createRequire(pinoEntryPath)(pinoEntryPath) as PinoModule;
  } catch {
    // pino is not installed
    return;
  }
  const { writeSym, messageKeySym, hooksSym } = pino.symbols;
  if (!writeSym || !messageKeySym || !hooksSym) {
    logDebug("The pino symbols were not recognized");
    return;
  }
  // Probe instance for prototype discovery only; it never writes. The owner of
  // the write method is a grand-prototype shared by every logger and child.
  const probeLogger = pino({}, { write: () => {} });
  const writePrototype = findPrototypeOwning(probeLogger, writeSym);
  if (!writePrototype || typeof writePrototype[writeSym] !== "function") {
    logDebug("The pino write prototype was not recognized");
    return;
  }
  if (hasPatchMarker(writePrototype, PINO_PATCH_MARKER)) {
    return;
  }
  const logger = loggerProvider.getLogger("pino");
  const retrofittedHooks = new Map<
    PinoStreamWriteHooks,
    ((line: string) => string) | undefined
  >();
  // The level and messageKey of the write in progress; the streamWrite hook
  // call is strictly synchronous within the write.
  let writeContext: { level: number; messageKey: string } | undefined;

  const captureLine = (line: string): void => {
    if (!writeContext) {
      return;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const message = parsed[writeContext.messageKey];
      if (message === undefined) {
        return;
      }
      // The stashed numeric level is immune to formatters.level rewrites
      const severityNumber = severityNumberFromPinoLevel(writeContext.level);
      logger.emit({
        severityNumber,
        severityText: severityTextFromNumber(severityNumber),
        body: message as AnyValue,
        timestamp: typeof parsed.time === "number" ? parsed.time : undefined,
      });
    } catch {
      // Capture must never throw into the application's logging path
    }
  };

  // Loggers created without a hooks option share pino's module-level default
  // hooks object, so one installation covers all of them; loggers with their
  // own hooks are retrofitted on their first write, composing after the user's
  // hook so capture reads the line the user's hook produced.
  const ensureStreamWriteHook = (
    hooks: PinoStreamWriteHooks | undefined,
  ): void => {
    if (!hooks || hasPatchMarker(hooks, PINO_HOOK_MARKER)) {
      return;
    }
    const userStreamWrite = hooks.streamWrite;
    hooks.streamWrite = (line: string): string => {
      const processed = userStreamWrite ? userStreamWrite(line) : line;
      captureLine(processed);
      return processed;
    };
    setPatchMarker(hooks, PINO_HOOK_MARKER);
    retrofittedHooks.set(hooks, userStreamWrite);
  };

  const originalWrite = writePrototype[writeSym] as (
    ...args: unknown[]
  ) => unknown;
  writePrototype[writeSym] = function (
    this: Record<symbol, unknown>,
    ...args: unknown[]
  ): unknown {
    try {
      ensureStreamWriteHook(this[hooksSym] as PinoStreamWriteHooks | undefined);
      const level = args[2];
      writeContext =
        typeof level === "number"
          ? { level, messageKey: String(this[messageKeySym]) }
          : undefined;
    } catch {
      writeContext = undefined;
    }
    try {
      return originalWrite.apply(this, args);
    } finally {
      writeContext = undefined;
    }
  };
  setPatchMarker(writePrototype, PINO_PATCH_MARKER);
  restorePinoCapture = () => {
    writePrototype[writeSym] = originalWrite;
    clearPatchMarker(writePrototype, PINO_PATCH_MARKER);
    for (const [hooks, userStreamWrite] of retrofittedHooks) {
      hooks.streamWrite = userStreamWrite;
      clearPatchMarker(hooks, PINO_HOOK_MARKER);
    }
  };
}

// Test seam: restores the console methods, detaches the winston write shadow
// and transports, removes the pino write patch and streamWrite hooks, and
// resets the peer resolver.
export function uninstallLogCapture(): void {
  restoreConsoleCapture?.();
  restoreConsoleCapture = undefined;
  restoreWinstonCapture?.();
  restoreWinstonCapture = undefined;
  restorePinoCapture?.();
  restorePinoCapture = undefined;
  peerResolver.resolveEntryPath = defaultResolveEntryPath;
}

// Peer libraries resolve with createRequire so the SDK reaches the user's own
// copy; tests replace this seam to simulate an absent library.
export const peerResolver = {
  resolveEntryPath(id: string): string {
    return createRequire(import.meta.url).resolve(id);
  },
};
const defaultResolveEntryPath = peerResolver.resolveEntryPath;

// Emits into the private provider under the active context, so the log
// pipeline resolves the request linkage from the emitting span.
function emitCapturedLogRecord(
  logger: Logger,
  logRecord: {
    severityNumber: SeverityNumber;
    severityText: string;
    body: AnyValue;
    timestamp?: number;
  },
): void {
  try {
    logger.emit(logRecord);
  } catch {
    // Capture must never throw into the application's logging path
  }
}

function findPrototypeOwning(
  instance: object,
  key: PropertyKey,
): Record<PropertyKey, unknown> | undefined {
  let prototype = Object.getPrototypeOf(instance) as Record<
    PropertyKey,
    unknown
  > | null;
  while (prototype !== null && !Object.hasOwn(prototype, key)) {
    prototype = Object.getPrototypeOf(prototype) as Record<
      PropertyKey,
      unknown
    > | null;
  }
  return prototype ?? undefined;
}

function hasPatchMarker(target: object, marker: symbol): boolean {
  return (target as Record<symbol, unknown>)[marker] === true;
}

function setPatchMarker(target: object, marker: symbol): void {
  (target as Record<symbol, unknown>)[marker] = true;
}

function clearPatchMarker(target: object, marker: symbol): void {
  (target as Record<symbol, unknown>)[marker] = undefined;
}

function severityNumberFromPinoLevel(level: number): SeverityNumber {
  if (level <= 10) {
    return SeverityNumber.TRACE;
  }
  if (level <= 20) {
    return SeverityNumber.DEBUG;
  }
  if (level <= 30) {
    return SeverityNumber.INFO;
  }
  if (level <= 40) {
    return SeverityNumber.WARN;
  }
  if (level <= 50) {
    return SeverityNumber.ERROR;
  }
  return SeverityNumber.FATAL;
}

function severityTextFromNumber(severityNumber: SeverityNumber): string {
  if (severityNumber >= SeverityNumber.FATAL) {
    return "fatal";
  }
  if (severityNumber >= SeverityNumber.ERROR) {
    return "error";
  }
  if (severityNumber >= SeverityNumber.WARN) {
    return "warn";
  }
  if (severityNumber >= SeverityNumber.INFO) {
    return "info";
  }
  if (severityNumber >= SeverityNumber.DEBUG) {
    return "debug";
  }
  return "trace";
}
