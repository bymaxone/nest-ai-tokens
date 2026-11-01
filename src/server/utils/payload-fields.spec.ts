/**
 * @fileoverview Pins the role of every ledger record field: the payload hash covers the fields that
 * describe the call and none of the identity or lifecycle fields, the replay fingerprint covers the
 * request fields plus a conditional field only when the new request controls it, and a stored row
 * matches a new request through the model-name allowance. Each field is changed in turn.
 * @layer server
 */
import type { NewUsageRecord } from '../../shared'
import type { FieldRole } from './payload-fields'
import { ROLE_FIELDS } from './payload-fields'
import { computePayloadHash } from './payload-hash'
import { requestFingerprint, sameRequest } from './replay-match'

/** A complete record with every optional field set, so each can be changed. */
const BASE: NewUsageRecord = {
  tenantId: 'tenant-1',
  idempotencyKey: 'key-1',
  scope: { type: 'user', id: 'u1' },
  beneficiary: { type: 'team', id: 'team-1' },
  requestedBy: 'actor',
  provider: 'openai',
  model: 'gpt-5-mini',
  requestedModel: 'gpt-5-mini',
  operation: 'chat',
  serviceTier: 'standard',
  feature: 'chat.reply',
  tags: ['a'],
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 1,
  cacheWrite5mTokens: 2,
  cacheWrite1hTokens: 3,
  reasoningTokens: 4,
  audioInTokens: 5,
  audioOutTokens: 6,
  imageInTokens: 7,
  imageOutTokens: 8,
  totalTokens: 1536,
  extraUnits: { web_search_requests: 1 },
  priceVersionId: 'price-1',
  rawCostNanoUsd: 6_025_000n,
  surchargeNanoUsd: 5n,
  billedCostNanoUsd: 24_100_000n,
  markupMultiplier: 4,
  currency: 'USD',
  priceMissing: false,
  status: 'posted',
  reversedByRecordId: 'rev-by',
  reversesRecordId: 'rev-of',
  correlationId: 'corr',
  requestId: 'req',
  isSystemCost: false,
  systemCostCategory: 'cat',
  enforced: false,
  occurredAt: new Date('2026-06-01T00:00:00.000Z'),
}

/** One change per field. The compiler rejects a record field that has no entry. */
const CHANGES: Record<keyof NewUsageRecord, Partial<NewUsageRecord>> = {
  tenantId: { tenantId: 'tenant-2' },
  idempotencyKey: { idempotencyKey: 'key-2' },
  scope: { scope: { type: 'user', id: 'u2' } },
  beneficiary: { beneficiary: { type: 'team', id: 'team-2' } },
  requestedBy: { requestedBy: 'other' },
  provider: { provider: 'anthropic' },
  model: { model: 'gpt-5' },
  requestedModel: { requestedModel: 'gpt-5' },
  operation: { operation: 'embeddings' },
  serviceTier: { serviceTier: 'priority' },
  feature: { feature: 'other.feature' },
  tags: { tags: ['b'] },
  inputTokens: { inputTokens: 1001 },
  outputTokens: { outputTokens: 501 },
  cacheReadTokens: { cacheReadTokens: 11 },
  cacheWrite5mTokens: { cacheWrite5mTokens: 12 },
  cacheWrite1hTokens: { cacheWrite1hTokens: 13 },
  reasoningTokens: { reasoningTokens: 14 },
  audioInTokens: { audioInTokens: 15 },
  audioOutTokens: { audioOutTokens: 16 },
  imageInTokens: { imageInTokens: 17 },
  imageOutTokens: { imageOutTokens: 18 },
  totalTokens: { totalTokens: 1537 },
  extraUnits: { extraUnits: { web_search_requests: 2 } },
  priceVersionId: { priceVersionId: 'price-2' },
  rawCostNanoUsd: { rawCostNanoUsd: 1n },
  surchargeNanoUsd: { surchargeNanoUsd: 6n },
  billedCostNanoUsd: { billedCostNanoUsd: 1n },
  markupMultiplier: { markupMultiplier: 5 },
  currency: { currency: 'EUR' },
  priceMissing: { priceMissing: true },
  status: { status: 'reversed' },
  reversedByRecordId: { reversedByRecordId: 'other' },
  reversesRecordId: { reversesRecordId: 'other' },
  correlationId: { correlationId: 'other' },
  requestId: { requestId: 'other' },
  isSystemCost: { isSystemCost: true },
  systemCostCategory: { systemCostCategory: 'other' },
  enforced: { enforced: true },
  occurredAt: { occurredAt: new Date('2026-06-02T00:00:00.000Z') },
}

/** The role of each field, read back from the table. */
const FIELD_ROLES = Object.fromEntries(
  (Object.entries(ROLE_FIELDS) as [FieldRole, readonly (keyof NewUsageRecord)[]][]).flatMap(([role, fields]) => fields.map((field) => [field, role])),
) as Record<keyof NewUsageRecord, FieldRole>
const KEYS = Object.keys(CHANGES) as (keyof NewUsageRecord)[]

describe('every record field has a role the hash and the replay check respect', () => {
  /** Every field has exactly one role, so a field added to the record is classified before it can be compared. */
  it('classifies each field once', () => {
    const listed = Object.values(ROLE_FIELDS).flat()
    expect(listed.slice().sort()).toEqual(Object.keys(CHANGES).sort())
    expect(new Set(listed).size).toBe(listed.length)
  })

  /** The payload hash covers every field that describes the call, and neither the identity nor the lifecycle fields. */
  it.each(KEYS)('payload hash: changing %s', (key) => {
    const role = FIELD_ROLES[key]
    const changed = computePayloadHash({ ...BASE, ...CHANGES[key] }) !== computePayloadHash(BASE)
    expect(changed).toBe(role !== 'identity' && role !== 'lifecycle')
  })

  /** The replay check reads request fields only, and a conditional field only when the new request controls it. */
  it.each(KEYS)('replay fingerprint: changing %s', (key) => {
    const role = FIELD_ROLES[key]
    const changes = (basis: { providerReported: boolean; occurredAtSupplied: boolean }): boolean =>
      requestFingerprint({ ...BASE, ...CHANGES[key] }, basis) !== requestFingerprint(BASE, basis)
    expect(changes({ providerReported: false, occurredAtSupplied: false })).toBe(role === 'request')
    expect(changes({ providerReported: true, occurredAtSupplied: false })).toBe(role === 'request' || role === 'rated-cost')
    expect(changes({ providerReported: false, occurredAtSupplied: true })).toBe(role === 'request' || role === 'occurred-at')
  })
})

describe('sameRequest', () => {
  const basis = { providerReported: false, occurredAtSupplied: false, responseModel: '' }
  const named = { ...BASE, model: 'claude-sonnet-4-5', requestedModel: 'claude-sonnet-4-5' }

  /** A row that kept the empty model and one that was named after `baseModel` are the same request as a response with no model. */
  it.each([
    ['named after baseModel', named],
    ['kept empty', { ...named, model: '' }],
  ])('matches a stored row that %s when the response carried no model', (_name, stored) => {
    expect(sameRequest(stored, named, basis)).toBe(true)
  })

  /** A response that did carry a model is a different request from a row whose model was empty. */
  it('does not match an empty-model row when the response named a model', () => {
    expect(sameRequest({ ...named, model: '' }, named, { ...basis, responseModel: 'claude-sonnet-4-5' })).toBe(false)
  })

  /** The empty-model allowance does not reach a different baseModel. */
  it('does not match another requested model', () => {
    expect(sameRequest({ ...named, model: '', requestedModel: 'claude-haiku-4-5' }, named, basis)).toBe(false)
  })

  /** A tag list in another order is another request, as it is for the payload hash. */
  it('treats tag order as part of the request', () => {
    expect(sameRequest({ ...BASE, tags: ['a', 'b'] }, { ...BASE, tags: ['b', 'a'] }, { ...basis, responseModel: BASE.model })).toBe(false)
  })
})
