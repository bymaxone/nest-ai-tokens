/**
 * @fileoverview The column lists the adapter's statements are built from, as literal text.
 * @layer prisma
 *
 * Each module is loaded by its row and asserted as a promise: a list that cannot be turned into SQL throws while the module loads, which
 * a static import would report as a suite that does not run instead of a row that fails.
 */

describe('the column lists of the statements', () => {
  /** The names are the columns of the schema: a renamed, added or removed one fails here, not only against a database. */
  it('names the usage columns of the schema', async () => {
    const text = import('./adapter-sql').then((loaded) => loaded.USAGE_COLUMNS_SQL.text)
    await expect(text).resolves.toBe('"id", "tenantId", "scopeType", "scopeId", "beneficiaryType", "beneficiaryId", "requestedBy", "provider", "model", "requestedModel", "operation", "serviceTier", "feature", "tags", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "reasoningTokens", "audioInTokens", "audioOutTokens", "imageInTokens", "imageOutTokens", "totalTokens", "extraUnits", "priceVersionId", "rawCostNanoUsd", "surchargeNanoUsd", "billedCostNanoUsd", "markupMultiplier", "currency", "priceMissing", "status", "reversedByRecordId", "reversesRecordId", "idempotencyKey", "payloadHash", "correlationId", "requestId", "isSystemCost", "systemCostCategory", "enforced", "prevHash", "hash", "occurredAt", "createdAt", "updatedAt"')
  })

  /** The price table, as the schema spells it. */
  it('names the price columns of the schema', async () => {
    const text = import('./adapter-sql').then((loaded) => loaded.PRICE_COLUMNS_SQL.text)
    await expect(text).resolves.toBe('"id", "provider", "model", "operation", "serviceTier", "inputNanoUsdPerMillion", "outputNanoUsdPerMillion", "cacheReadNanoUsdPerMillion", "cacheWrite5mNanoUsdPerMillion", "cacheWrite1hNanoUsdPerMillion", "reasoningNanoUsdPerMillion", "audioInNanoUsdPerMillion", "audioOutNanoUsdPerMillion", "imageInNanoUsdPerMillion", "imageOutNanoUsdPerMillion", "tierThresholdTokens", "tierInputNanoUsdPerMillion", "tierOutputNanoUsdPerMillion", "unitRates", "currency", "effectiveFrom", "effectiveTo", "source"')
  })

  /** The budget table, as the schema spells it. */
  it('names the budget columns of the schema', async () => {
    const text = import('./budget-rows').then((loaded) => loaded.BUDGET_COLUMNS_SQL.text)
    await expect(text).resolves.toBe('"id", "tenantId", "scopeType", "scopeId", "features", "limitNanoUsd", "limitTokens", "limitCount", "window", "anchorAt", "expiresAt", "softThresholds", "policy", "createdAt", "updatedAt"')
  })
})
