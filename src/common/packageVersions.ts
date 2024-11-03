import { createRequire } from "module";

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

export function isPackageInstalled(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch (error) {
    const _require = createRequire(import.meta.url);
    try {
      _require.resolve(name);
      return true;
    } catch (error) {
      return false;
    }
  }
}
