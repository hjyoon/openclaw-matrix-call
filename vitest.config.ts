import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
