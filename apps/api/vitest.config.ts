import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Test files share one test database, so they run one at a time
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
