import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { logDebug } from "./logger.js";
import type { Signal, Spool } from "./spool.js";

const SERIALIZATION_CHUNK_SIZE = 32;

export function serializeInChunksToSpool<Item>(
  items: Item[],
  serializeChunk: (chunk: Item[]) => Uint8Array | undefined,
  spool: Spool,
  signal: Signal,
  resultCallback: (result: ExportResult) => void,
): void {
  const appends: Promise<void>[] = [];
  try {
    for (let start = 0; start < items.length; start += SERIALIZATION_CHUNK_SIZE) {
      const payload = serializeChunk(items.slice(start, start + SERIALIZATION_CHUNK_SIZE));
      if (payload) {
        appends.push(spool.append(signal, payload));
      }
    }
  } catch (error) {
    logDebug(`Error exporting ${signal}: ${String(error)}`);
    resultCallback({ code: ExportResultCode.FAILED, error: toError(error) });
    return;
  }
  Promise.all(appends).then(
    () => resultCallback({ code: ExportResultCode.SUCCESS }),
    (error: unknown) =>
      resultCallback({
        code: ExportResultCode.FAILED,
        error: toError(error),
      }),
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
