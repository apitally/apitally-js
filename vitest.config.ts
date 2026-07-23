import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    // tests/bun holds the bun:test suite, run separately via `bun test tests/bun`
    exclude: [...configDefaults.exclude, "tests/bun/**"],
    coverage: {
      include: ["src/**/*.ts"],
      reporter: ["text", "lcovonly"],
    },
  },
});
