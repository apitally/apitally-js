import { createRequire } from "module";

function getRequire() {
  if (typeof require !== "undefined") {
    return require;
  } else {
    return createRequire(import.meta.url);
  }
}

export function getPackageVersion(name: string): string | null {
  try {
    const _require = getRequire();
    return _require(`${name}/package.json`).version || null;
  } catch (error) {
    return null;
  }
}

export function isPackageInstalled(name: string): boolean {
  try {
    const _require = getRequire();
    _require.resolve(name);
    return true;
  } catch (error) {
    return false;
  }
}
