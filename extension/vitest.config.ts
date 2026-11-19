import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      ['test/unit/components.test.tsx', 'jsdom'],
    ],
    include: ['test/unit/**/*.test.{ts,tsx}', 'test/integration/**/*.test.ts'],
    testTimeout: 30000,
  },
});
