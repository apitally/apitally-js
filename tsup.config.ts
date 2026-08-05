import { cp } from "node:fs/promises";
import { fixImportsPlugin } from "esbuild-fix-imports-plugin";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "es2022",
  dts: true,
  sourcemap: true,
  splitting: false,
  bundle: false,
  clean: true,
  shims: true,
  onSuccess: () => cp("src/adonisjs/stubs", "dist/adonisjs/stubs", { recursive: true }),
  esbuildPlugins: [fixImportsPlugin()],
});
