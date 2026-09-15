import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "es2022",
  dts: true,
  sourcemap: true,
  unbundle: true,
  fixedExtension: false,
  cjsDefault: false,
  clean: true,
  deps: { neverBundle: true },
  copy: [{ from: "src/adonisjs/stubs", to: "dist/adonisjs" }],
});
