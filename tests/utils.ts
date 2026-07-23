import { vi } from "vitest";

export const WRITE_TOKEN = `apt_${"a".repeat(24)}`;

// Captures SDK diagnostics written to process.stderr; the global teardown restores the spy.
export function captureStderr(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(
    (chunk: Uint8Array | string) => {
      written.push(chunk.toString());
      return true;
    },
  );
  return written;
}
