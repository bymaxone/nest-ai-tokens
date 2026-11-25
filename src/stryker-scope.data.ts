/**
 * @fileoverview What differs in this library from the shared mutation-scope spec: the shipped source that `mutate` leaves out and why,
 * the expected shape of the package entries, the end-to-end suites that own the PostgreSQL store, and the data files the build ships.
 * The spec that reads it is a template of the shared CI repository and is not compared with this file.
 * @layer tests
 */
import type { Exclusion } from './stryker-scope.spec'

/** Every shipped source file that `mutate` leaves out. */
export const EXCLUSIONS: readonly Exclusion[] = [
  {
    kind: 'barrel',
    reason: 'Re-exports only: there is no statement to mutate, and a barrel that gains logic fails this spec.',
    files: [
      'src/prices/index.ts',
      'src/shared/index.ts',
      'src/shared/normalizers/index.ts',
      'src/server/index.ts',
      'src/server/config/index.ts',
      'src/server/enforcement/index.ts',
      'src/server/errors/index.ts',
      'src/server/interfaces/index.ts',
      'src/server/services/index.ts',
    ],
  },
  {
    kind: 'types',
    reason: 'Types only: it compiles to nothing, and a runtime declaration added to it fails this spec.',
    files: ['src/server/config/resolved-options.ts', 'src/server/interfaces/*.interface.ts'],
  },
  {
    kind: 'e2e-owned',
    reason:
      'The store runs its statements against PostgreSQL, so a mutant needs a database to be judged: it has no unit spec, ' +
      'and the Testcontainers suite on the four Prisma cells pins its behaviour. Mutating it would start one database ' +
      'per mutant, hours per cell.',
    files: ['src/prisma/index.ts', 'src/prisma/wallet-writes.ts'],
  },
]

/** What the package entries of `tsup.config.ts` must yield. */
export const EXPECTED = {
  entries: 5,
  includes: ['src/server/index.ts', 'src/redis/index.ts', 'src/prisma/index.ts'],
  minShipped: 60,
} as const

/** The end-to-end suites that exercise the subpath of the end-to-end-owned files. */
export const E2E_OWNED: { readonly suites: readonly string[]; readonly subpath: string } | null = {
  suites: ['wallet-plan-stability', 'prisma-wallet-budget', 'prisma-migrations'].map((name) => `test/e2e/${name}.e2e-spec.ts`),
  subpath: '@bymax-one/nest-ai-tokens/prisma',
}

/** Shipped files that are data, not TypeScript, copied next to the Prisma bundle by `tsup.config.ts`. */
export const SHIPPED_DATA = [
  { path: 'src/prisma/schema.prisma.fragment', tsupNeedle: 'src/prisma/schema.prisma.fragment' },
  { path: 'src/prisma/migrations', tsupNeedle: 'src/prisma/migrations' },
] as const
