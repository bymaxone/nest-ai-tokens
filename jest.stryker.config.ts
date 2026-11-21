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
  // The first spec reads the adapter's source text from disk and compares it with literals. Stryker
  // instruments that file before it runs the tests, so the comparison cannot hold there; the SQL
  // text itself is asserted by the builders spec, which does run. The second bundles the absorb
  // helper from the files on disk and runs it in a child process, so it would bundle the instrumented
  // source; the helper's behaviour is asserted in-process by host-call-failures.spec.ts, which does run.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/src/prisma/timestamp-writes.spec.ts', '<rootDir>/src/absorb-child.spec.ts'],
}

export default config
