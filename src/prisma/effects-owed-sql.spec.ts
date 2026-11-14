/**
 * @fileoverview Unit tests of the effects-owed SQL builders: the wrapper that writes the marker with its usage-row
 * statement, the sweep's query for the rows that owe effects, the statement that clears a marker, and the mapping of an
 * owed row.
 * @layer prisma
 */

import { DB_NOW_SQL } from './adapter-sql'
import { clearEffectsOwedSql, effectsOwedForSql, effectsOwedSql, mapOwedRow, withMarkerSql } from './effects-owed-sql'
import { sql } from './sql'
import { T1, usageRow } from '../../test/fakes/prisma-rows'

describe('the effects-owed SQL builders', () => {
  /** A write that owes nothing is returned as it is. */
  it('returns the statement unchanged when there is no marker', () => {
    const write = sql`UPDATE "ai_usage_records" SET "status" = ${'posted'} RETURNING *`
    expect(withMarkerSql(write)).toBe(write)
  })

  /** A write that owes effects is wrapped so that both statements run as one, and the caller still reads the written row. */
  it('wraps the statement in a data-modifying WITH that writes the marker from the written row', () => {
    const write = sql`UPDATE "ai_usage_records" SET "status" = ${'posted'} RETURNING *`
    const wrapped = withMarkerSql(write, { reservedBilledNanoUsd: 9n, reservedTokens: 7, reason: 'customer-dispute' })
    expect(wrapped.text).toContain('WITH written AS (UPDATE "ai_usage_records" SET "status" = $1 RETURNING *)')
    expect(wrapped.text).toContain('marked AS (')
    expect(wrapped.text).toContain('INSERT INTO "ai_usage_effects_owed" ("recordId", "tenantId", "owedAt", "reservedBilledNanoUsd", "reservedTokens", "reason")')
    expect(wrapped.text).toContain(`SELECT "id", "tenantId", ${DB_NOW_SQL.text}, $2, $3, $4 FROM written`)
    expect(wrapped.text.trim().endsWith('SELECT * FROM written')).toBe(true)
    expect(wrapped.values).toEqual(['posted', 9n, 7, 'customer-dispute'])
  })

  /** A marker that keeps nothing (a release) writes nulls for the reserved values and the reason. */
  it('writes null reserved values and reason for a marker that keeps none', () => {
    expect(withMarkerSql(sql`SELECT 1`, {}).values).toEqual([null, null, null])
  })

  /** The sweep's query reads only markers older than the cutoff, oldest first with the record id as tiebreak, up to the limit. */
  it('selects the owed rows older than the cutoff, oldest first, with what the marker kept', () => {
    const query = effectsOwedSql(T1, 50)
    expect(query.text).toContain('o."reservedBilledNanoUsd" AS "owedReservedBilledNanoUsd", o."reservedTokens" AS "owedReservedTokens", o."reason" AS "owedReason"')
    expect(query.text).toContain('FROM "ai_usage_effects_owed" o JOIN "ai_usage_records" r ON r."id" = o."recordId"')
    expect(query.text).toContain('WHERE o."owedAt" < ')
    expect(query.text).toContain('ORDER BY o."owedAt" ASC, o."recordId" ASC LIMIT ')
    expect(query.values).toEqual([T1, 50])
  })

  /** The lookup of one row's marker joins the same columns and filters by the record id. */
  it('selects the marker of one row with what it kept', () => {
    const query = effectsOwedForSql('rec-1')
    expect(query.text).toContain('o."reservedBilledNanoUsd" AS "owedReservedBilledNanoUsd", o."reservedTokens" AS "owedReservedTokens", o."reason" AS "owedReason"')
    expect(query.text).toContain('FROM "ai_usage_effects_owed" o JOIN "ai_usage_records" r ON r."id" = o."recordId"')
    expect(query.text).toContain('WHERE o."recordId" = $1')
    expect(query.values).toEqual(['rec-1'])
  })

  /** Clearing deletes the marker of one row and reports the id when it had one. */
  it('deletes the marker of one row', () => {
    const clear = clearEffectsOwedSql('rec-1')
    expect(clear.text).toBe('DELETE FROM "ai_usage_effects_owed" WHERE "recordId" = $1 RETURNING "recordId"')
    expect(clear.values).toEqual(['rec-1'])
  })

  /** The owed row carries the record and what the marker kept, as bigint and number; a row with none keeps neither. */
  it('maps an owed row, keeping the reserved values only when present', () => {
    const kept = mapOwedRow(usageRow({ owedReservedBilledNanoUsd: 25n, owedReservedTokens: 1500 }))
    expect(kept.record.id).toBe('rec-1')
    expect(kept.reservedBilledNanoUsd).toBe(25n)
    expect(kept.reservedTokens).toBe(1500)
    const none = mapOwedRow(usageRow({ owedReservedBilledNanoUsd: null, owedReservedTokens: null, owedReason: null }))
    expect('reservedBilledNanoUsd' in none).toBe(false)
    expect('reservedTokens' in none).toBe(false)
    expect('reason' in none).toBe(false)
    expect(mapOwedRow(usageRow({ owedReason: 'customer-dispute' })).reason).toBe('customer-dispute')
    const absent = mapOwedRow(usageRow())
    expect('reservedBilledNanoUsd' in absent).toBe(false)
    expect('reservedTokens' in absent).toBe(false)
    expect('reason' in absent).toBe(false)
  })
})
