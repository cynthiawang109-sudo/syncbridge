import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    setupFiles: ["tests/env.ts"],
  },
});
