import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Many tests drive real git, processes and sockets; the 5 s default fails on a loaded machine (CI shares it).
    testTimeout: 30_000
  }
});
