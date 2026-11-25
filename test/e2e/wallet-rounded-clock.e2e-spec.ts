/**
 * @fileoverview E2E: the balance an appended grant carries judges `effectiveAt` and `expiresAt` on the clock its own
 * `createdAt` is stored with. The column keeps milliseconds and rounds the database clock to them, so a comparison
 * on the unrounded clock can credit a grant that the stored row then reads as not yet due, or the reverse.
 * @layer test
 */

import { entryDeltaSql } from '../../src/prisma/adapter-sql'
import { grantEntry } from '../contracts/wallet-store.contract'
import { startPostgres, type PostgresFixture } from './harness'

let pg: PostgresFixture
beforeAll(async () => {
  pg = await startPostgres()
}, 180_000)
afterAll(async () => {
  await pg.stop()
})

const ATTEMPTS = 200

interface Clock {
  readonly stored: Date
  readonly roundedUp: boolean
}

/**
 * Judge `entry` with the delta statement inside one transaction, next to the clock that transaction's `createdAt`
 * would carry. The clock does not move within a transaction, so the instant read first is the instant judged.
 */
async function deltaAtStoredClock(
  build: (stored: Date) => Parameters<typeof grantEntry>[0],
): Promise<{ clock: Clock; delta: bigint; amount: bigint }> {
  return await pg.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ stored: Date; roundedUp: boolean }[]>(
      `SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AS "stored",
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS "roundedUp"`,
    )
    const clock = rows[0] as Clock
    const entry = grantEntry(build(clock.stored))
    const statement = entryDeltaSql(entry)
    const delta = await tx.$queryRawUnsafe<{ delta: bigint }[]>(`SELECT ${statement.text} AS "delta"`, ...statement.parameters)
    return { clock, delta: (delta[0] as { delta: bigint }).delta, amount: entry.amountNanoUsd }
  })
}

describe('the balance an appended grant carries, on the clock its row is stored with', () => {
  /** A grant effective at the stored millisecond is due as it is appended, whichever way the clock rounded to it. */
  it('credits a grant whose effectiveAt is the stored millisecond, also when the clock rounded up to it', async () => {
    let roundedUp = 0
    for (let i = 0; i < ATTEMPTS; i += 1) {
      const { clock, delta, amount } = await deltaAtStoredClock((stored) => ({ idempotencyKey: `e${i}`, amountNanoUsd: 5n, effectiveAt: stored }))
      if (clock.roundedUp) roundedUp += 1
      expect(delta).toBe(amount)
    }
    expect(roundedUp).toBeGreaterThan(0)
  })

  /** A grant expiring at the stored millisecond is not due as it is appended: the stored row reads `expiresAt > createdAt` as false. */
  it('credits nothing for a grant whose expiresAt is the stored millisecond, also when the clock rounded up to it', async () => {
    let roundedUp = 0
    for (let i = 0; i < ATTEMPTS; i += 1) {
      const { clock, delta } = await deltaAtStoredClock((stored) => ({
        idempotencyKey: `x${i}`,
        amountNanoUsd: 5n,
        effectiveAt: new Date(stored.getTime() - 60_000),
        expiresAt: stored,
      }))
      if (clock.roundedUp) roundedUp += 1
      expect(delta).toBe(0n)
    }
    expect(roundedUp).toBeGreaterThan(0)
  })
})
