import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/tests/**/*.integration.test.ts'],
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 30_000,
  },
})
