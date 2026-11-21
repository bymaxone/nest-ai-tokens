import {
  asArray,
  asObject,
  buildUsage,
  detailsArray,
  detailsObject,
  knownServiceTier,
  num,
  openAiServiceTier,
  readResponse,
  remainder,
  requireNum,
  str,
  sumCounts,
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
    /** A count that is there passes; an absent one, or null, is 0; anything else is refused, where it used to collapse to 0. */
    it('reads a count, treats absent and null as 0, and refuses the rest', () => {
      expect(num(7)).toBe(7)
      expect(num(0)).toBe(0)
      expect(num(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
      expect(num(undefined)).toBe(0)
      expect(num(null)).toBe(0)
      for (const bad of [Number.NaN, '7', -1, 1.5, 2 ** 53, Number.POSITIVE_INFINITY, true, [], {}]) expect(() => num(bad)).toThrow(Error)
    })
  })

  describe('requireNum', () => {
    /** A count is returned. */
    it('returns a count', () => {
      expect(requireNum(3, 'p', 'f')).toBe(3)
      expect(requireNum(0, 'p', 'f')).toBe(0)
    })

    /** A missing value, or one that is not a count, throws a plain Error naming the field. */
    it('throws with the provider and field on invalid input', () => {
      expect(() => requireNum(undefined, 'openai', 'usage.x')).toThrow('openai: missing or invalid count "usage.x"')
      expect(() => requireNum(null, 'openai', 'usage.x')).toThrow(Error)
      for (const bad of [Number.NaN, '3', -1, 1.5, 2 ** 53]) expect(() => requireNum(bad, 'openai', 'usage.x')).toThrow(Error)
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
    /** Counts survive; an unset entry is skipped; an entry that is not a count, or a map that is no object, is refused, where it was dropped. */
    it('extracts counts and refuses what is not one', () => {
      expect(toolUseCounts({ web_search_requests: 2, unset: null, absent: undefined }, 'p')).toEqual({ web_search_requests: 2 })
      expect(toolUseCounts({ unset: null }, 'p')).toBeUndefined()
      expect(toolUseCounts(null, 'p')).toBeUndefined()
      expect(toolUseCounts(undefined, 'p')).toBeUndefined()
      expect(() => toolUseCounts({ web_search_requests: 'x' }, 'p')).toThrow(Error)
      expect(() => toolUseCounts([2], 'p')).toThrow(Error)
    })
  })

  describe('detailsObject, detailsArray, sumCounts and remainder', () => {
    /** A container that is there must be of its kind; absent and null are absent. */
    it('reads a container, treats absent and null as absent, and refuses another kind', () => {
      expect(detailsObject({ a: 1 }, 'p', 'f')).toEqual({ a: 1 })
      expect(detailsObject(undefined, 'p', 'f')).toBeUndefined()
      expect(detailsObject(null, 'p', 'f')).toBeUndefined()
      for (const bad of [[], 'x', 5, true]) expect(() => detailsObject(bad, 'p', 'f')).toThrow('p: "f" must be an object')
      expect(detailsArray([1], 'p', 'f')).toEqual([1])
      expect(detailsArray(undefined, 'p', 'f')).toBeUndefined()
      expect(detailsArray(null, 'p', 'f')).toBeUndefined()
      for (const bad of [{}, 'x', 5]) expect(() => detailsArray(bad, 'p', 'f')).toThrow('p: "f" must be a list')
    })

    /** Counts add up to a count; parts are taken out of their total, and parts past the total are refused. */
    it('sums counts and refuses a sum past the safe range or parts past their total', () => {
      expect(sumCounts(1, 2, 3)).toBe(6)
      expect(sumCounts()).toBe(0)
      expect(() => sumCounts(Number.MAX_SAFE_INTEGER, 1)).toThrow(Error)
      expect(remainder(100, [20, 5], 'p', 'f')).toBe(75)
      expect(remainder(100, [100], 'p', 'f')).toBe(0)
      expect(() => remainder(100, [60, 41], 'p', 'f')).toThrow('p: the parts of "f" are more than the whole')
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
