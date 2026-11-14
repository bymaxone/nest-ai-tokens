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
