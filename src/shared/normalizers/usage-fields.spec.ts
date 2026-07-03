import {
  asArray,
  asObject,
  buildUsage,
  knownServiceTier,
  num,
  openAiServiceTier,
  readResponse,
  requireNum,
  str,
  toolUseCounts,
} from './usage-fields'

describe('usage-fields helpers', () => {
  describe('asObject', () => {
    /** Plain objects pass through; arrays, null, and primitives do not. */
    it('narrows only plain objects', () => {
      expect(asObject({ a: 1 })).toEqual({ a: 1 })
      expect(asObject([1])).toBeUndefined()
      expect(asObject(null)).toBeUndefined()
      expect(asObject(5)).toBeUndefined()
    })
  })

  describe('asArray', () => {
    /** Arrays pass through; everything else is undefined. */
    it('narrows only arrays', () => {
      expect(asArray([1, 2])).toEqual([1, 2])
      expect(asArray({})).toBeUndefined()
    })
  })

  describe('num', () => {
    /** Finite numbers pass; NaN, non-numbers, and undefined collapse to 0. */
    it('coerces to a finite number or 0', () => {
      expect(num(7)).toBe(7)
      expect(num(Number.NaN)).toBe(0)
      expect(num('7')).toBe(0)
      expect(num(undefined)).toBe(0)
    })
  })

  describe('requireNum', () => {
    /** A valid finite number is returned. */
    it('returns a finite number', () => {
      expect(requireNum(3, 'p', 'f')).toBe(3)
    })

    /** A missing or non-finite value throws a plain Error naming the field. */
    it('throws with the provider and field on invalid input', () => {
      expect(() => requireNum(undefined, 'openai', 'usage.x')).toThrow('openai: missing or invalid numeric field "usage.x"')
      expect(() => requireNum(Number.NaN, 'openai', 'usage.x')).toThrow(Error)
    })
  })

  describe('str', () => {
    /** Strings pass; non-strings are undefined. */
    it('narrows only strings', () => {
      expect(str('x')).toBe('x')
      expect(str(1)).toBeUndefined()
    })
  })

  describe('knownServiceTier', () => {
    /** Recognized tiers pass; unknown strings and non-strings are undefined. */
    it('accepts only catalog tiers', () => {
      expect(knownServiceTier('batch')).toBe('batch')
      expect(knownServiceTier('scale')).toBeUndefined()
      expect(knownServiceTier(42)).toBeUndefined()
    })
  })

  describe('openAiServiceTier', () => {
    /** OpenAI's silent-downgrade `default` maps to `standard`; other tiers pass. */
    it("maps 'default' to 'standard' and passes known tiers", () => {
      expect(openAiServiceTier('default')).toBe('standard')
      expect(openAiServiceTier('flex')).toBe('flex')
      expect(openAiServiceTier('unknown')).toBeUndefined()
    })
  })

  describe('toolUseCounts', () => {
    /** Numeric entries survive; non-numeric entries drop; empty/non-object is undefined. */
    it('extracts finite numeric counts', () => {
      expect(toolUseCounts({ web_search_requests: 2, bad: 'x' })).toEqual({ web_search_requests: 2 })
      expect(toolUseCounts({ bad: 'x' })).toBeUndefined()
      expect(toolUseCounts(null)).toBeUndefined()
    })
  })

  describe('buildUsage', () => {
    /** All optional fields present are carried through; numeric defaults are respected. */
    it('carries every optional field when present', () => {
      const usage = buildUsage({
        provider: 'openai',
        model: 'm',
        operation: 'chat',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWrite5mTokens: 4,
        cacheWrite1hTokens: 5,
        reasoningTokens: 6,
        audioInTokens: 7,
        audioOutTokens: 8,
        imageInTokens: 9,
        imageOutTokens: 10,
        serviceTier: 'flex',
        serverToolUse: { web_search_requests: 1 },
        providerReportedCostNanoUsd: 11n,
        raw: { k: 'v' },
      })
      expect(usage).toMatchObject({
        cacheWrite1hTokens: 5,
        serviceTier: 'flex',
        serverToolUse: { web_search_requests: 1 },
        providerReportedCostNanoUsd: 11n,
        raw: { k: 'v' },
      })
    })

    /** Absent numeric categories default to 0 and absent optionals are omitted. */
    it('defaults numeric categories to 0 and omits absent optionals', () => {
      const usage = buildUsage({ provider: 'openai', model: 'm', operation: 'chat', inputTokens: 1, outputTokens: 2 })
      expect(usage.cacheReadTokens).toBe(0)
      expect(usage.imageOutTokens).toBe(0)
      expect('serviceTier' in usage).toBe(false)
      expect('serverToolUse' in usage).toBe(false)
      expect('providerReportedCostNanoUsd' in usage).toBe(false)
      expect('raw' in usage).toBe(false)
    })
  })

  describe('readResponse', () => {
    /** A valid response yields both the response and its usage sub-object. */
    it('returns the response and usage', () => {
      const { response, usage } = readResponse({ model: 'm', usage: { prompt_tokens: 1 } }, 'p')
      expect(response.model).toBe('m')
      expect(usage.prompt_tokens).toBe(1)
    })

    /** A missing usage object throws; a non-object response also throws. */
    it('throws when the usage object is absent', () => {
      expect(() => readResponse({ model: 'm' }, 'openai')).toThrow('openai: missing "usage" object')
      expect(() => readResponse(null, 'openai')).toThrow(Error)
    })

    /** A custom usage key is honored (Gemini uses usageMetadata). */
    it('honors a custom usage key', () => {
      const { usage } = readResponse({ usageMetadata: { promptTokenCount: 1 } }, 'gemini', 'usageMetadata')
      expect(usage.promptTokenCount).toBe(1)
    })
  })
})
