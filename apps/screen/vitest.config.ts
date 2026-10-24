import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // CI runners share a host, and load-cap.mjs intentionally bypasses its
    // worker cap there. Bound concurrent SQLite fixtures and module loading
    // rather than letting each runner size its pool to the whole machine.
    ...(process.env.CI ? { maxWorkers: 2, minWorkers: 1 } : {}),
  },
});
