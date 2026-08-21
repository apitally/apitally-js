const emittedWarnings = new Set<string>();

export function logDebug(message: string): void {
  if (process.env.APITALLY_DEBUG) {
    writeToStderr("DEBUG", message);
  }
}

export function logWarning(message: string): void {
  if (emittedWarnings.has(message)) {
    return;
  }
  emittedWarnings.add(message);
  writeToStderr("WARNING", message);
}

// Allows a recurring-condition warning to fire again after the condition
// recovered (e.g. spool writes succeeding again after a failure).
export function resetWarning(message: string): void {
  emittedWarnings.delete(message);
}

export function logError(message: string): void {
  writeToStderr("ERROR", message);
}

export function resetEmittedWarnings(): void {
  emittedWarnings.clear();
}

// The console methods are a log capture surface, so SDK diagnostics write to stderr
// directly and can never feed back into capture.
function writeToStderr(level: string, message: string): void {
  process.stderr.write(`[apitally] ${level}: ${message}\n`);
}
