import type { Config } from 'jest'
import base from './jest.config.ts'

/**
 * End-to-end test configuration. Targets specs under `test/e2e` that exercise
 * the library against real PostgreSQL (and Redis) instances via Testcontainers.
 * The package name is mapped to the source entry points so fixtures consume the
 * public API exactly as a downstream app would. Worker count stays capped at 50%
 * (from the base config) so only one container set is exercised at a time.
 * A run that matches no spec fails when `CI` is `true` and passes otherwise.
 */
const config: Config = {
  ...base,
  rootDir: '.',
  // Root at the repository; specs are scoped to `test/e2e` via `testMatch`.
  roots: ['<rootDir>'],
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  collectCoverageFrom: undefined,
  coverageThreshold: undefined,
  testTimeout: 120_000,
  // One Testcontainers set at a time (memory-safe; never fan out container sets).
  maxWorkers: 1,
  passWithNoTests: process.env['CI'] !== 'true',
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
