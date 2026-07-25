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

// Union of `winston` npm, syslog, and CLI level vocabularies.
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

// Console has no transport or filter hook, so capture wraps each method. The
// wrappers call the original first and never throw into the application.
export function installConsoleCapture(loggerProvider: LoggerProvider): void {
  if (hasPatchMarker(console, CONSOLE_PATCH_MARKER)) {
    return;
  }
  const logger = loggerProvider.getLogger("console");
  const restoreSteps: (() => void)[] = [];
  for (const [method, severityNumber] of Object.entries(CONSOLE_METHOD_SEVERITIES) as [
    keyof typeof CONSOLE_METHOD_SEVERITIES,
    SeverityNumber,
  ][]) {
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

// Capture uses `winston`'s transport contract so the `silent` option, level
// filters, and formats run first. The write wrapper only attaches the transport.
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
    // Resolving the transport base from the `winston` entry keeps both modules
    // in the same installed package tree.
    TransportBase = requireFromWinston("winston-transport") as new () => object;
  } catch {
    return;
  }
  // createLogger creates a DerivedLogger subclass per call; all loggers share
  // the prototype that owns configure.
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

    log(info: { level?: unknown; message?: unknown }, callback?: () => void): void {
      const severityText = typeof info.level === "string" ? info.level : "";
      emitCapturedLogRecord(logger, {
        severityNumber: WINSTON_LEVEL_SEVERITIES[severityText] ?? SeverityNumber.INFO,
        severityText,
        body: info.message as AnyValue,
      });
      callback?.();
    }
  }

  // WeakRef prevents the registry from retaining logger instances.
  const attachedLoggers = new Set<WeakRef<WinstonLoggerInstance>>();
  const attachedTransports = new WeakMap<WinstonLoggerInstance, object>();
  const originalWrite = loggerPrototype.write as (...args: unknown[]) => boolean;
  // Attaching through add() before delegation covers existing loggers,
  // reattaches after clear(), and drains `winston`'s zero-transport buffer.
  loggerPrototype.write = function (this: WinstonLoggerInstance, ...args: unknown[]): boolean {
    try {
      if (
        !this.transports.some((transport) => hasPatchMarker(transport, WINSTON_TRANSPORT_MARKER))
      ) {
        const transport = new ApitallyTransport();
        this.add(transport);
        attachedLoggers.add(new WeakRef(this));
        attachedTransports.set(this, transport);
      }
    } catch {
      // An attach failure must never break the application's logging.
    }
    return originalWrite.apply(this, args);
  };
  setPatchMarker(loggerPrototype, WINSTON_PATCH_MARKER);
  restoreWinstonCapture = () => {
    loggerPrototype.write = originalWrite;
    clearPatchMarker(loggerPrototype, WINSTON_PATCH_MARKER);
    for (const loggerRef of attachedLoggers) {
      const winstonLogger = loggerRef.deref();
      const transport = winstonLogger && attachedTransports.get(winstonLogger);
      if (!winstonLogger || !transport) {
        continue;
      }
      try {
        winstonLogger.remove(transport);
      } catch {
        // The logger may already have removed the transport itself.
      }
    }
  };
}

// Capture uses `pino`'s streamWrite hook so redaction and serializers run first.
// The write wrapper only installs the hook and records the level.
export function installPinoCapture(loggerProvider: LoggerProvider): void {
  let pino: PinoModule;
  try {
    const pinoEntryPath = peerResolver.resolveEntryPath("pino");
    pino = createRequire(pinoEntryPath)(pinoEntryPath) as PinoModule;
  } catch {
    return;
  }
  const { writeSym, messageKeySym, hooksSym } = pino.symbols;
  if (!writeSym || !messageKeySym || !hooksSym) {
    logDebug("The pino symbols were not recognized");
    return;
  }
  // The probe locates the prototype that owns write, which all loggers and child
  // loggers share.
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
  // WeakRef prevents the registry from retaining hook objects.
  const captureInstalledHooks = new Set<WeakRef<PinoStreamWriteHooks>>();
  const userStreamWrites = new WeakMap<PinoStreamWriteHooks, (line: string) => string>();
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
      // The stored numeric level is unaffected by formatters.level rewrites.
      const severityNumber = severityNumberFromPinoLevel(writeContext.level);
      logger.emit({
        severityNumber,
        severityText: severityTextFromNumber(severityNumber),
        body: message as AnyValue,
        timestamp: typeof parsed.time === "number" ? parsed.time : undefined,
      });
    } catch {
      // Capture must never throw into the application's logging path.
    }
  };

  // Loggers without hooks share `pino`'s default hook object. Other hook objects
  // are wrapped on first write after the user's hook runs.
  const ensureStreamWriteHook = (hooks: PinoStreamWriteHooks | undefined): void => {
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
    captureInstalledHooks.add(new WeakRef(hooks));
    if (userStreamWrite) {
      userStreamWrites.set(hooks, userStreamWrite);
    }
  };

  const originalWrite = writePrototype[writeSym] as (...args: unknown[]) => unknown;
  writePrototype[writeSym] = function (this: Record<symbol, unknown>, ...args: unknown[]): unknown {
    try {
      ensureStreamWriteHook(this[hooksSym] as PinoStreamWriteHooks | undefined);
      const level = args[2];
      writeContext =
        typeof level === "number" ? { level, messageKey: String(this[messageKeySym]) } : undefined;
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
    for (const hooksRef of captureInstalledHooks) {
      const hooks = hooksRef.deref();
      if (!hooks) {
        continue;
      }
      hooks.streamWrite = userStreamWrites.get(hooks);
      clearPatchMarker(hooks, PINO_HOOK_MARKER);
    }
  };
}

export function uninstallLogCapture(): void {
  restoreConsoleCapture?.();
  restoreConsoleCapture = undefined;
  restoreWinstonCapture?.();
  restoreWinstonCapture = undefined;
  restorePinoCapture?.();
  restorePinoCapture = undefined;
  peerResolver.resolveEntryPath = defaultResolveEntryPath;
}

// createRequire resolves peer libraries from the user's installation. Tests
// replace peerResolver.resolveEntryPath to simulate an absent peer.
export const peerResolver = {
  resolveEntryPath(id: string): string {
    return createRequire(import.meta.url).resolve(id);
  },
};
const defaultResolveEntryPath = peerResolver.resolveEntryPath;

// The active context lets the log pipeline resolve the emitting request.
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
    // Capture must never throw into the application's logging path.
  }
}

function findPrototypeOwning(
  instance: object,
  key: PropertyKey,
): Record<PropertyKey, unknown> | undefined {
  let prototype = Object.getPrototypeOf(instance) as Record<PropertyKey, unknown> | null;
  while (prototype !== null && !Object.hasOwn(prototype, key)) {
    prototype = Object.getPrototypeOf(prototype) as Record<PropertyKey, unknown> | null;
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
