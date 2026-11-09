import {
  AMOUNT_FIELDS,
  RELEASE_FIELDS,
  REVERSAL_LINKAGE_FIELD,
  SETTLEMENT_FIELDS,
  SETTLEMENT_PATCH_KEYS,
  isLegalLedgerTransition,
  isLegalTransitionPatchKey,
} from './ledger-fields.constants'

describe('ledger-field whitelists', () => {
  /** The settlement patch set is exactly the settlement columns plus the reversal linkage. */
  it('composes SETTLEMENT_PATCH_KEYS from the settlement fields and the reversal linkage', () => {
    for (const field of SETTLEMENT_FIELDS) expect(SETTLEMENT_PATCH_KEYS.has(field)).toBe(true)
    expect(SETTLEMENT_PATCH_KEYS.has(REVERSAL_LINKAGE_FIELD)).toBe(true)
    expect(SETTLEMENT_PATCH_KEYS.size).toBe(SETTLEMENT_FIELDS.length + 1)
  })

  /** A void may annotate exactly the correlation and request linkage, no other column. */
  it('lets a release annotate exactly the correlation and request linkage', () => {
    expect([...RELEASE_FIELDS]).toEqual(['correlationId', 'requestId'])
  })

  /** Release annotations never overlap the append-only amounts. */
  it('keeps the release annotations disjoint from the append-only amounts', () => {
    for (const field of RELEASE_FIELDS) expect(AMOUNT_FIELDS).not.toContain(field)
  })
})

describe('isLegalLedgerTransition', () => {
  /** pending → posted (settle) and pending → released (void) are the two legal hold outcomes. */
  it('permits settling and voiding a hold', () => {
    expect(isLegalLedgerTransition('pending', 'posted')).toBe(true)
    expect(isLegalLedgerTransition('pending', 'released')).toBe(true)
  })

  /** posted → reversed (annotate) is the only legal post-posting flip. */
  it('permits annotating a posted record as reversed', () => {
    expect(isLegalLedgerTransition('posted', 'reversed')).toBe(true)
  })

  /** A pending hold may not jump straight to reversed. */
  it('rejects an illegal pending → reversed jump', () => {
    expect(isLegalLedgerTransition('pending', 'reversed')).toBe(false)
  })

  /** A posted record may not revert to pending. */
  it('rejects an illegal posted → pending revert', () => {
    expect(isLegalLedgerTransition('posted', 'pending')).toBe(false)
  })

  /** A released/terminal record cannot transition anywhere. */
  it('rejects a transition out of a terminal state', () => {
    expect(isLegalLedgerTransition('released', 'posted')).toBe(false)
  })
})

describe('isLegalTransitionPatchKey', () => {
  /** pending → posted may patch a settlement amount. */
  it('allows a settlement field on settle', () => {
    expect(isLegalTransitionPatchKey('pending', 'posted', 'billedCostNanoUsd')).toBe(true)
  })

  /** pending → posted may not patch an immutable identity column. */
  it('rejects an immutable identity field on settle', () => {
    expect(isLegalTransitionPatchKey('pending', 'posted', 'tenantId')).toBe(false)
  })

  /** pending → released may annotate correlation linkage. */
  it('allows an audit-annotation field on release', () => {
    expect(isLegalTransitionPatchKey('pending', 'released', 'correlationId')).toBe(true)
  })

  /** pending → released may never patch an amount. */
  it('rejects an amount field on release', () => {
    expect(isLegalTransitionPatchKey('pending', 'released', 'billedCostNanoUsd')).toBe(false)
  })

  /** A release voids a hold, so it may not backfill settlement pricing metadata. */
  it('rejects settlement pricing metadata on release', () => {
    expect(isLegalTransitionPatchKey('pending', 'released', 'priceVersionId')).toBe(false)
  })

  /** posted → reversed may set only the reversal linkage. */
  it('allows the reversal linkage on reversal', () => {
    expect(isLegalTransitionPatchKey('posted', 'reversed', REVERSAL_LINKAGE_FIELD)).toBe(true)
  })

  /** posted → reversed may not annotate anything else. */
  it('rejects a non-linkage field on reversal', () => {
    expect(isLegalTransitionPatchKey('posted', 'reversed', 'correlationId')).toBe(false)
  })

  /** An illegal from-state (not posted) reaching the reversal branch patches nothing. */
  it('rejects a patch on an illegal transition into reversed', () => {
    expect(isLegalTransitionPatchKey('released', 'reversed', REVERSAL_LINKAGE_FIELD)).toBe(false)
  })

  /** A wholly illegal transition patches nothing. */
  it('rejects any patch on an illegal transition', () => {
    expect(isLegalTransitionPatchKey('posted', 'pending', 'correlationId')).toBe(false)
    expect(isLegalTransitionPatchKey('pending', 'reversed', 'correlationId')).toBe(false)
  })
})

const STATUSES = ['pending', 'posted', 'released', 'reversed'] as const

describe('ledger transition tables', () => {
  /** Exactly three of the sixteen status pairs are legal transitions: settle, void and annotate-as-reversed. */
  it('permits exactly settle, void and reverse over every status pair', () => {
    const legal = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const)).filter(([from, to]) =>
      isLegalLedgerTransition(from, to),
    )
    expect(legal).toEqual([
      ['pending', 'posted'],
      ['pending', 'released'],
      ['posted', 'reversed'],
    ])
  })

  /** Each legal transition patches exactly its own whitelist and no other pair patches anything. */
  it('allows each patch key only on the transition whose whitelist holds it', () => {
    const keys = [...SETTLEMENT_PATCH_KEYS, ...RELEASE_FIELDS, REVERSAL_LINKAGE_FIELD, 'id', 'tenantId', 'idempotencyKey', 'bogus']
    const allowed = (from: string, to: string, key: string): boolean => {
      if (from === 'pending' && to === 'posted') return key === REVERSAL_LINKAGE_FIELD || (SETTLEMENT_FIELDS as readonly string[]).includes(key)
      if (from === 'pending' && to === 'released') return (RELEASE_FIELDS as readonly string[]).includes(key)
      if (from === 'posted' && to === 'reversed') return key === 'reversedByRecordId'
      return false
    }
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        for (const key of new Set(keys)) {
          expect({ from, to, key, ok: isLegalTransitionPatchKey(from, to, key) }).toEqual({ from, to, key, ok: allowed(from, to, key) })
        }
      }
    }
  })
})
