import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/**/*.test.ts', 'hub/**/*.test.ts', 'tools/**/*.test.ts', 'deploy/**/*.test.ts', 'web/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
