/**
 * @fileoverview A valid `Date` from another realm (a `vm` context) is a date everywhere a date is read, not only where the guard
 * accepts it. Each place that tells a date from an object has to agree with the guard: the JSON boundary clones it as a date, the
 * payload hash encodes it as its ISO string, and the SQL builder binds it as a UTC timestamp. A place that read it as a plain
 * object would turn it into `{}`, hash it as an object or bind it as an unreadable parameter.
 * @layer server
 */

import { runInNewContext } from 'node:vm'
import { sql } from './prisma/sql'
import { toJsonSafe } from './server/utils/to-json-safe'
import { deriveIdempotencyKey } from './shared/utils/idempotency'
import { isDate } from './shared/utils/is-date'

const ISO = '2026-01-01T00:00:00.000Z'

/** The same instant as a `Date` of this realm and of another, and a subclass of this realm's. */
const local = (): Date => new Date(ISO)
const foreign = (): Date => runInNewContext(`new Date('${ISO}')`) as Date

describe('a date from another realm', () => {
  it('is a date to the brand check, as a Date of this realm and a subclass are', () => {
    expect([local(), foreign(), new (class extends Date {})(ISO)].map(isDate)).toEqual([true, true, true])
  })

  it('is not one to the brand check when it only looks like one', () => {
    expect([new Proxy(local(), {}), { getTime: () => 0 }, Object.assign({}, { [Symbol.toStringTag]: 'Date' }), null, undefined, 0, ISO].map(isDate)).toEqual([false, false, false, false, false, false, false])
  })

  it('crosses the JSON boundary as the same ISO timestamp a local date does', () => {
    expect(JSON.stringify(toJsonSafe({ anchorAt: foreign(), expiresAt: local() }))).toBe(`{"anchorAt":"${ISO}","expiresAt":"${ISO}"}`)
  })

  it('hashes into the payload key as the same instant of a local date does', () => {
    expect(deriveIdempotencyKey({ at: foreign(), n: 1n })).toBe(deriveIdempotencyKey({ at: local(), n: 1n }))
  })

  it('is bound by the SQL builder as a UTC timestamp, as a local date is', () => {
    const [foreignStatement, localStatement] = [foreign(), local()].map((date) => sql`SELECT ${date}`)
    expect(foreignStatement?.text).toBe(localStatement?.text)
    expect(foreignStatement?.parameters).toEqual([ISO])
  })
})
