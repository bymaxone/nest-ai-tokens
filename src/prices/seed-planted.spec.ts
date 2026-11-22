/**
 * @fileoverview The price snapshot is built when its module is first loaded, so a key planted on `Object.prototype` BEFORE that load must not
 * end up in a row. Each row loads the module in a fresh registry with the key planted, and compares every row with the rows of a clean load.
 * @layer prices
 */

import type { MODEL_PRICES_SEED as Seed } from './model-prices.seed'

/** Load the snapshot module in a fresh module registry, so that its rows are built now. */
async function loadSeed(): Promise<typeof Seed> {
  let rows: typeof Seed = []
  await jest.isolateModulesAsync(async () => {
    rows = (await import('./model-prices.seed')).MODEL_PRICES_SEED
  })
  return rows
}

describe('the price snapshot loaded with a key planted on Object.prototype', () => {
  it.each([
    ['operation', 'embedding'],
    ['serviceTier', 'priority'],
    ['tierThresholdTokens', 9_999],
    ['tierInputNanoUsdPerMillion', 9_999n],
    ['tierOutputNanoUsdPerMillion', 9_999n],
    ['unitRates', { planted_unit: 9_999n }],
    ['cacheReadNanoUsdPerMillion', 9_999n],
  ])('keeps the table rate of every row when %s is planted before the first load', async (key, value) => {
    const clean = await loadSeed()
    Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false })
    let planted: typeof Seed
    try {
      planted = await loadSeed()
    } finally {
      Reflect.deleteProperty(Object.prototype, key)
    }
    expect(planted.length).toBe(clean.length)
    expect(planted).toEqual(clean)
  })
})
