import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [swc.vite(), swc.rollup()],
  test: {
    coverage: {
      enabled: true,
      include: ["src/**/*"],
      exclude: ["src/**/types.ts"],
      reporter: ["text", "lcovonly"],
    },
  },
});
