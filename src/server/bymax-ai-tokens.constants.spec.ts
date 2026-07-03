import * as tokens from './bymax-ai-tokens.constants'

describe('injection tokens', () => {
  /** All eleven DI tokens are unique symbols so no two ports collide. */
  it('exports eleven distinct symbols', () => {
    const values = Object.values(tokens)
    expect(values).toHaveLength(11)
    for (const value of values) expect(typeof value).toBe('symbol')
    expect(new Set(values).size).toBe(values.length)
  })

  /** The primary options token is present. */
  it('includes the resolved-options token', () => {
    expect(tokens.BYMAX_AI_TOKENS_OPTIONS.toString()).toBe('Symbol(BYMAX_AI_TOKENS_OPTIONS)')
  })
})
