import { defineConfig } from 'vitest/config'

/**
 * Opt-in live checks that call real external services (never part of `npm test`).
 * Run with `npm run validate:search`; see scripts/live/productSearch.live.ts.
 */
export default defineConfig({
  test: {
    include: ['scripts/live/**/*.live.ts'],
    environment: 'node',
    testTimeout: 10 * 60 * 1000,
    // Always print the result tables, also when the run passes.
    silent: false,
  },
})
