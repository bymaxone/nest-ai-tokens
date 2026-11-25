/**
 * @fileoverview The shipped SQL migrations, concatenated in file order, for the suites that build a fresh database.
 * @layer test
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIRECTORY = join(__dirname, '../../src/prisma/migrations')

/** Every shipped migration, in file order, as one SQL text. */
export function shippedMigrationSql(): string {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(DIRECTORY, name), 'utf8'))
    .join('\n')
}

/**
 * One shipped migration by the prefix of its file name (`0003`), so a suite that tests the rollback of a migration reads that file and not
 * the ones that came after it.
 */
export function migrationSqlStartingWith(prefix: string): string {
  const names = readdirSync(DIRECTORY).filter((name) => name.startsWith(prefix) && name.endsWith('.sql'))
  const [only] = names
  if (names.length !== 1 || only === undefined) throw new Error(`expected exactly one migration starting with ${prefix}`)
  return readFileSync(join(DIRECTORY, only), 'utf8')
}
