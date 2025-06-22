import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts", "src/**/*.js"],
  format: ["cjs", "esm"],
  platform: "node",
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
  onSuccess: 'copyfiles "src/**/*.stub" --up="1" dist',
});
