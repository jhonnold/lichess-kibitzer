import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is web/. Backend/shared tests live in test/.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
