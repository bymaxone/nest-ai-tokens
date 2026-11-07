import type { Config } from 'jest'
import base from './jest.config.ts'

/**
 * Jest configuration consumed by the Stryker mutation-testing runner. Coverage
 * collection is disabled because Stryker tracks mutant kills itself.
 */
const config: Config = {
  ...base,
  collectCoverage: false,
  coverageThreshold: undefined,
  // This spec reads the adapter's source text from disk and compares it with literals. Stryker
  // instruments that file before it runs the tests, so the comparison cannot hold there; the SQL
  // text itself is asserted by the builders spec, which does run.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/src/prisma/timestamp-writes.spec.ts'],
}

export default config
