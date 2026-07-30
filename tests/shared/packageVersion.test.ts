import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { Module } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePackageEntryPath, resolvePackageVersion } from "../../src/packageVersion.js";

describe("packageVersion", () => {
  it("resolves installed package entry paths and peer package versions", () => {
    expect(resolvePackageEntryPath("hono")).toContain("hono");
    expect(resolvePackageVersion("hono")).toMatch(/^\d+\.\d+\.\d+/);
    expect(resolvePackageVersion("express")).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("skips nearer package metadata owned by a different package", () => {
    const directory = mkdtempSync(join(tmpdir(), "apitally-package-version-"));
    const packageDirectory = join(directory, "node_modules", "example-peer");
    const entryDirectory = join(packageDirectory, "dist");
    const entryPath = join(entryDirectory, "index.js");
    mkdirSync(entryDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "example-peer", version: "1.2.3" }),
    );
    writeFileSync(
      join(entryDirectory, "package.json"),
      JSON.stringify({ name: "nested-dependency", version: "9.9.9" }),
    );

    const nodeModule = Module as unknown as {
      _resolveFilename(request: string, ...args: unknown[]): string;
    };
    const resolveFilename = nodeModule._resolveFilename;
    vi.spyOn(nodeModule, "_resolveFilename").mockImplementation((request, ...args) =>
      request === "example-peer" ? entryPath : resolveFilename(request, ...args),
    );

    expect(resolvePackageVersion("example-peer")).toBe("1.2.3");
  });

  it("returns undefined when peer resolution fails", () => {
    expect(resolvePackageVersion("package-that-does-not-exist")).toBeUndefined();
  });
});
