import { createRequire } from "node:module";

export function getPackageVersion(name: string): string | null {
  const packageJsonPath = `${name}/package.json`;
  try {
    return require(packageJsonPath).version || null;
  } catch (error) {
    try {
      const _require = createRequire(import.meta.url);
      return _require(packageJsonPath).version || null;
    } catch (error) {
      return null;
    }
  }
}
