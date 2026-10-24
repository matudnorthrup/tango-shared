import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Subpaths before the package itself: a prefix alias would send them to index.ts/<subpath>.
      "@tango/atlas-memory/capture": path.resolve(__dirname, "../atlas-memory/src/capture.ts"),
      "@tango/atlas-memory/memory-client": path.resolve(__dirname, "../atlas-memory/src/memory-client.ts"),
      "@tango/atlas-memory": path.resolve(__dirname, "../atlas-memory/src/index.ts"),
      "@tango/core": path.resolve(__dirname, "../core/src/index.ts"),
      "@tango/voice": path.resolve(__dirname, "../voice/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    setupFiles: [path.resolve(__dirname, "test/setup.ts")],
    include: ["test/**/*.test.ts"],
  },
});
