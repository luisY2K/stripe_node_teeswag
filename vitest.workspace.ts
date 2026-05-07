import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "unit",
      include: ["tests/unit/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "integration",
      include: ["tests/integration/**/*.test.ts"],
      hookTimeout: 180_000,
      testTimeout: 180_000,
    },
  },
]);
