import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/tests/**/*.test.ts', 'scripts/**/*.test.mjs'],
    passWithNoTests: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/client/**', 'packages/*/src/index.ts'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
})
