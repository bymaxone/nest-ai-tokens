/**
 * @fileoverview The container images the end-to-end suites start, read from the one file that pins them
 * (`.github/ci-images/Dockerfile`), so a fixture, a workflow pre-pull and the dependency bot cannot name different
 * images.
 * @layer test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The pinned reference of the stage `name` in the images file, as `repository:tag@sha256:digest`. */
function pinned(name: string): string {
  const text = readFileSync(join(__dirname, '../../.github/ci-images/Dockerfile'), 'utf8')
  for (const match of text.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/gim)) {
    if (match[2] === name) return match[1]!
  }
  throw new Error(`no image named ${name} in .github/ci-images/Dockerfile`)
}

/** The PostgreSQL image every database fixture starts. */
export const POSTGRES_IMAGE = pinned('postgres')

/** The Redis image every cache fixture starts. */
export const REDIS_IMAGE = pinned('redis')
