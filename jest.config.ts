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
  // `src/prisma/adapter-sql.ts` (row mappers, value and filter builders, SQL text) is pure and is
  // covered here. `src/prisma/index.ts`, the store that runs those statements against PostgreSQL, is
  // owned by the Testcontainers e2e suite and is excluded from the unit gate by name; the `index.ts`
  // glob would exclude it as well, but a glob hides the reason.
  collectCoverageFrom: ['src/**/*.ts', '!**/index.ts', '!src/prisma/index.ts', '!**/*.spec.ts'],
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
