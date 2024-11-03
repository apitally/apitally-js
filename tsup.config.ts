import { defineConfig } from "tsup";

export default defineConfig({
  format: ["cjs", "esm"],
  platform: "node",
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
});
