/**
 * @fileoverview Unit tests of the wallet statements that build a query of their own: the open grants in burn order and the
 * cross-wallet listing of debits, whose text pins the cast of the prefix length (Prisma 6 binds a number as bigint), the
 * byte-order collation of the keyset and the sort, and the bounds.
 * @layer prisma
 */

import { balanceAtSql, balanceBreakdownSql } from './balance-statements'
import {
  mapWalletDebitRow,
  openGrantsSql,
  walletDebitsSql,
  type WalletDebitRow,
} from './wallet-statements'

const T1 = new Date('2026-01-01T00:00:00.000Z')
const T2 = new Date('2026-01-02T00:00:00.000Z')

describe('the wallet statements', () => {
  /** The burn order decides the sort of the open grants and nothing else of the statement. */
  it.each([
    ['expiry', 'g."expiresAt" ASC NULLS LAST, g."createdAt" ASC, g."id" ASC'],
    ['priority', 'g."priority" ASC, g."createdAt" ASC, g."id" ASC'],
    ['fifo', 'g."createdAt" ASC, g."id" ASC'],
  ] as const)('sorts the open grants of a wallet in %s order', (order, sort) => {
    const query = openGrantsSql('w1', order, T1)
    expect(query.text).toContain(`ORDER BY ${sort}`)
    expect(query.values).toContain('w1')
  })

  /** The listing reads debits of every wallet, with the wallet's owner, inside the bounds and after the cursor. */
  it('lists the debits that start with one of the prefixes, inside the bounds and after the cursor', () => {
    const query = walletDebitsSql({
      keyPrefixes: ['hold:', 'record:'],
      olderThan: T2,
      newerThan: T1,
      limit: 25,
      after: { createdAt: T1, id: 'e1' },
    })
    expect(query.text).toContain(
      `left(e."idempotencyKey", $1::int) = $2 OR left(e."idempotencyKey", $3::int) = $4`,
    )
    expect(query.text).toContain(`e."type" = 'debit'`)
    expect(query.text).toContain('e."createdAt" >=')
    expect(query.text).toContain(`(e."createdAt", e."id" COLLATE "C") > (`)
    expect(query.text).toContain('::text COLLATE "C")')
    expect(query.text).toContain(`ORDER BY e."createdAt" ASC, e."id" COLLATE "C" ASC`)
    expect(query.values).toEqual([5, 'hold:', 7, 'record:', T2, T1, T1, 'e1', 25])
  })

  /** Without a lower bound or a cursor the statement carries neither condition. */
  it('carries no lower bound and no cursor when none is given', () => {
    const query = walletDebitsSql({ keyPrefixes: ['hold:'], olderThan: T2, limit: 10 })
    expect(query.text).not.toContain('e."createdAt" >=')
    expect(query.text).toContain('AND TRUE AND TRUE')
    expect(query.text).not.toContain('COLLATE "C") >')
    expect(query.values).toEqual([5, 'hold:', T2, 10])
  })

  /** No prefix matches nothing, as in the in-memory store. */
  it('matches no debit when no prefix is given', () => {
    expect(walletDebitsSql({ keyPrefixes: [], olderThan: T2, limit: 10 }).text).toContain('AND (FALSE) AND')
  })

  /** The listing maps a row to the entry and the wallet it belongs to. */
  it('maps a row to the debit and its wallet', () => {
    const row: WalletDebitRow = {
      id: 'e1',
      walletId: 'w1',
      type: 'debit',
      amountNanoUsd: -5n,
      priority: 0,
      effectiveAt: T1,
      expiresAt: null,
      usageRecordId: null,
      idempotencyKey: 'hold:k',
      reason: null,
      createdAt: T1,
      walletTenantId: 't1',
      walletOwnerType: 'user',
      walletOwnerId: 'u1',
    }
    expect(mapWalletDebitRow(row)).toEqual({
      ref: { tenantId: 't1', ownerType: 'user', ownerId: 'u1' },
      entry: {
        id: 'e1',
        walletId: 'w1',
        type: 'debit',
        amountNanoUsd: -5n,
        priority: 0,
        effectiveAt: T1,
        idempotencyKey: 'hold:k',
        createdAt: T1,
      },
    })
  })
})

describe('the balance statements', () => {
  /** The balance at an instant is one statement over the wallet, with the instant bound once per predicate. */
  it('builds the balance at an instant as one statement of the wallet', () => {
    const query = balanceAtSql('w1', T1)
    expect(query.text).toContain('FROM "ai_wallets" w WHERE w."id"')
    expect(query.text).toContain('w."balanceNanoUsd"')
    expect(query.text).toContain('GREATEST(')
    expect(query.values.filter((value) => value === T1)).toHaveLength(5)
    expect(query.values).toContain('w1')
    expect(query.text).not.toContain(';')
  })

  /** The breakdown is one statement, the total first and then the buckets in the burn order. */
  it.each([
    ['expiry', '"expiresAt" ASC NULLS LAST, "createdAt" ASC, "id" ASC'],
    ['priority', '"priority" ASC, "createdAt" ASC, "id" ASC'],
    ['fifo', '"createdAt" ASC, "id" ASC'],
  ] as const)('orders the buckets of the breakdown in %s order after the total row', (order, sort) => {
    const query = balanceBreakdownSql('w1', T1, order)
    expect(query.text).toContain(`ORDER BY "rank" ASC, ${sort}`)
    expect(query.text).toContain("'total' AS \"kind\"")
    expect(query.values).toContain('w1')
  })
})
