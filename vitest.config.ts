import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests boot an in-process Postgres; give it room on slow CI runners.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
