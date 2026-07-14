import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/assets/**/*.ts",
        "src/domain/**/*.ts",
        "src/providers/**/*.ts",
        "src/security/**/*.ts",
        "src/server/security/**/*.ts",
        "src/server/startup/**/*.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
        "src/domain/**/*.ts": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 80,
        },
        "src/providers/**/*.ts": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 80,
        },
        "src/security/**/*.ts": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 80,
        },
        "src/server/security/**/*.ts": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 80,
        },
      },
    },
    testTimeout: 15_000,
  },
});
