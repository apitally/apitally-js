import { createRequire } from "module";

export function getPackageVersion(name: string): string | null {
  try {
    const _require = createRequire(import.meta.url);
    return _require(`${name}/package.json`).version || null; // eslint-disable-line @typescript-eslint/no-var-requires
  } catch (error) {
    return null;
  }
}
