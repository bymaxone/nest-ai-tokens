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
  // The third reads the tsup and Stryker configs and the shipped source text from disk to pin the mutation scope, which it cannot do on
  // instrumented files; the unit suite runs it on the files as they are. The three
  // check-function-length specs run a repository script as a child process and import nothing from
  // src/, so they judge no mutant.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/src/prisma/timestamp-writes.spec.ts', '<rootDir>/src/absorb-child.spec.ts', '<rootDir>/src/promise-chain-scan.spec.ts', '<rootDir>/src/stryker-scope.spec.ts', '<rootDir>/src/check-function-length.spec.ts', '<rootDir>/src/check-function-length.baseline.spec.ts', '<rootDir>/src/check-function-length.key.spec.ts'],
}

export default config
