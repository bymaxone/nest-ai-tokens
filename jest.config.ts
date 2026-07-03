import type { Config } from 'jest'

/**
 * Base Jest configuration. Specs are transformed by ts-jest against the
 * CommonJS-flavored `tsconfig.jest.json`. Worker count is capped at 50% to keep
 * memory bounded in CI and local runs. The global coverage threshold is 100% so
 * the per-PR `pnpm test:cov` gate enforces the same floor as the release gate,
 * with no drift. `passWithNoTests` keeps the gate green on an empty scaffold,
 * and `collectCoverageFrom` is scoped so the threshold never trips on zero
 * collected files.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.jest.json',
      },
    ],
  },
  moduleNameMapper: {
    '^@bymax-one/nest-ai-tokens/shared$': '<rootDir>/src/shared/index.ts',
    '^@bymax-one/nest-ai-tokens/prices$': '<rootDir>/src/prices/index.ts',
    '^@bymax-one/nest-ai-tokens/prisma$': '<rootDir>/src/prisma/index.ts',
    '^@bymax-one/nest-ai-tokens/redis$': '<rootDir>/src/redis/index.ts',
    '^@bymax-one/nest-ai-tokens$': '<rootDir>/src/server/index.ts',
  },
  clearMocks: true,
  restoreMocks: true,
  passWithNoTests: true,
  maxWorkers: '50%',
  // The Prisma adapter talks to PostgreSQL and is verified by the Testcontainers
  // e2e suite rather than unit specs, so the whole `src/prisma` adapter (its
  // `index.ts` store and the extracted `adapter-sql.ts` SQL builders) is excluded
  // from the unit coverage gate; the e2e suite exercises it end to end.
  collectCoverageFrom: ['src/**/*.ts', '!**/index.ts', '!**/*.spec.ts', '!src/prisma/**'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
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
