import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
      // Coverage gate (F-21, design §7): 90% line coverage on src/auth and
      // src/links. Enforced by `npm test` and `npm run test:coverage`; URL-7's
      // CI runs the same command — no merge without green lint + tests.
      thresholds: {
        'src/auth/**': { branches: 90, functions: 90, lines: 90, statements: 90 },
        'src/links/**': { branches: 90, functions: 90, lines: 90, statements: 90 },
      },
    },
  },
});
