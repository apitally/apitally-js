import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// createRequire resolves peer libraries from the user's installation.
export function resolvePackageEntryPath(packageName: string): string {
  return createRequire(import.meta.url).resolve(packageName);
}

export function resolvePackageVersion(packageName: string): string | undefined {
  try {
    const entryPath = resolvePackageEntryPath(packageName);
    const requireFromEntry = createRequire(entryPath);
    let directory = dirname(entryPath);
    while (true) {
      try {
        const packageJson = requireFromEntry(join(directory, "package.json")) as {
          name?: unknown;
          version?: unknown;
        };
        if (packageJson.name === packageName && typeof packageJson.version === "string") {
          return packageJson.version;
        }
      } catch {
        // The entry may be nested below directories without package metadata.
      }
      const parent = dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  } catch {
    return undefined;
  }
}
