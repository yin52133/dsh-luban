import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/tests/**/*.integration.test.ts',
      'scripts/tests/**/*.integration.test.ts',
    ],
    maxWorkers: 2,
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 30_000,
  },
})
