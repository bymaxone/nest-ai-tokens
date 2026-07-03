import type { Config } from 'jest'
import base from './jest.config.ts'

/**
 * End-to-end test configuration. Targets specs under `test/e2e` that exercise
 * the library against real PostgreSQL (and Redis) instances via Testcontainers.
 * The package name is mapped to the source entry points so fixtures consume the
 * public API exactly as a downstream app would. Worker count stays capped at 50%
 * (from the base config) so only one container set is exercised at a time.
 * `passWithNoTests` keeps the job green until end-to-end specs are added.
 */
const config: Config = {
  ...base,
  rootDir: '.',
  // Root at the repository so the suite stays green on a scaffold without an
  // end-to-end directory; specs are scoped to `test/e2e` via `testMatch`.
  roots: ['<rootDir>'],
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  collectCoverageFrom: undefined,
  coverageThreshold: undefined,
  testTimeout: 90_000,
  passWithNoTests: true,
  // Testcontainers keeps a background reaper connection alive for the process;
  // force a clean exit once the suite (which stops the containers) has finished.
  forceExit: true,
  moduleNameMapper: {
    '^@bymax-one/nest-ai-tokens/shared$': '<rootDir>/src/shared/index.ts',
    '^@bymax-one/nest-ai-tokens/prices$': '<rootDir>/src/prices/index.ts',
    '^@bymax-one/nest-ai-tokens/prisma$': '<rootDir>/src/prisma/index.ts',
    '^@bymax-one/nest-ai-tokens/redis$': '<rootDir>/src/redis/index.ts',
    '^@bymax-one/nest-ai-tokens$': '<rootDir>/src/server/index.ts',
  },
}

export default config
