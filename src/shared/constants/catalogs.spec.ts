import { AI_OPERATIONS } from './operations.constants'
import { AI_TOKENS_ERROR_CODES } from './error-codes.constants'
import { PROVIDER_IDS } from './provider-ids.constants'
import { SERVICE_TIERS } from './service-tiers.constants'
import { TOKEN_CATEGORIES } from './token-categories.constants'
import { WALLET_ENTRY_TYPES } from './wallet-entry-types.constants'

describe('shared catalogs', () => {
  /** The provider catalog carries the known ids the presets rely on. */
  it('lists the known providers', () => {
    expect(PROVIDER_IDS).toContain('openai')
    expect(PROVIDER_IDS).toContain('anthropic')
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length)
  })

  /** Operations include the chat/responses pair that shares price rows. */
  it('lists the operation kinds', () => {
    expect(AI_OPERATIONS).toEqual(
      expect.arrayContaining(['chat', 'responses', 'embeddings']),
    )
  })

  /** Service tiers cover the standard plus discounted/premium tiers. */
  it('lists the service tiers', () => {
    expect(SERVICE_TIERS).toEqual(['standard', 'batch', 'flex', 'priority'])
  })

  /** Ten independently rated token categories exist. */
  it('lists the token categories', () => {
    expect(TOKEN_CATEGORIES).toHaveLength(10)
    expect(TOKEN_CATEGORIES).toContain('cacheWrite5m')
  })

  /** Wallet entry types cover credits and debits. */
  it('lists the wallet entry types', () => {
    expect(WALLET_ENTRY_TYPES).toEqual(['grant', 'debit', 'refund', 'adjustment', 'expiry'])
  })

  /** Every error code maps to its own string, so the key union equals the value set. */
  it('maps each error code to itself', () => {
    for (const [key, value] of Object.entries(AI_TOKENS_ERROR_CODES)) {
      expect(value).toBe(key)
    }
    expect(Object.keys(AI_TOKENS_ERROR_CODES)).toHaveLength(15)
  })
})
