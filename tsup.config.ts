import { defineConfig } from "tsup";

export default defineConfig({
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
});
