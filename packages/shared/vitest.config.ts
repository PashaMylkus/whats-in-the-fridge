import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**/*.ts'],
      reporter: ['text'],
      // NFR-04: покриття доменної логіки ≥ 80 %
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
