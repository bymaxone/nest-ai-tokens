import type { Config } from 'jest'
import base from './jest.config.ts'

/**
 * Coverage run of `test:cov:all`: the unit run of `jest.config.ts` with the `text`, `text-summary` and `lcov`
 * reporters. It runs the same specs under `src/`, collects the same files and holds the same 100% thresholds; no
 * end-to-end file is collected. The index barrels are left out by the base `collectCoverageFrom`.
 */
const config: Config = {
  ...base,
  collectCoverage: true,
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
}

export default config
