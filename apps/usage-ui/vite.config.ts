import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Must match the server's mount path. The client derives asset and API URLs
// from this base, so set USAGE_UI_BASE_PATH for both build and runtime.
const basePath = (process.env.USAGE_UI_BASE_PATH ?? '/tango-usage').replace(/\/+$/, '');
const port = process.env.USAGE_UI_PORT ?? '9380';

export default defineConfig({
  base: `${basePath}/`,
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      [`${basePath}/api`]: `http://127.0.0.1:${port}`,
    },
  },
});
