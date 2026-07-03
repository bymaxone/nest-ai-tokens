import fc from 'fast-check'
import { floatUsdToNanoUsd, formatNanoUsd, perMillion } from './money'

describe('perMillion', () => {
  /** The spec §7.1 worked example: 1,000 tokens at $5/M is exactly $0.005. */
  it('computes the spec worked example exactly', () => {
    expect(perMillion(1000, 5_000_000_000n)).toBe(5_000_000n)
  })

  /** Zero tokens cost nothing regardless of rate. */
  it('returns 0n for zero tokens', () => {
    expect(perMillion(0, 5_000_000_000n)).toBe(0n)
  })

  /** The result must always equal the exact integer formula (no float drift). */
  it('matches the exact integer formula for arbitrary counts and rates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
        (tokens, rate) => {
          expect(perMillion(tokens, rate)).toBe((BigInt(tokens) * rate) / 1_000_000n)
        },
      ),
    )
  })
})

describe('floatUsdToNanoUsd', () => {
  /** $0.005 is 5,000,000 nano-USD. */
  it('converts a small dollar amount exactly', () => {
    expect(floatUsdToNanoUsd(0.005)).toBe(5_000_000n)
  })

  /** Round-half away from zero at nano precision. */
  it('rounds a half-nano up', () => {
    // 0.0000000015 USD = 1.5 nano → 2 nano.
    expect(floatUsdToNanoUsd(0.0000000015)).toBe(2n)
  })

  /** Negative amounts keep their sign. */
  it('handles negative amounts', () => {
    expect(floatUsdToNanoUsd(-0.005)).toBe(-5_000_000n)
  })

  /** Non-finite input is a programming error, not a silent zero. */
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'throws on the non-finite input %p',
    (value) => {
      expect(() => floatUsdToNanoUsd(value)).toThrow(RangeError)
    },
  )

  /** Micro-dollar amounts below $1,000 round-trip to their exact nano value. */
  it('is exact for micro-precision amounts under $1,000', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999_999_999 }), (microDollars) => {
        expect(floatUsdToNanoUsd(microDollars / 1e6)).toBe(BigInt(microDollars) * 1000n)
      }),
    )
  })
})

describe('formatNanoUsd', () => {
  /** Default rendering is USD with six fractional digits. */
  it('renders the default USD format', () => {
    expect(formatNanoUsd(5_000_000n)).toBe('$0.005000')
  })

  /** A zero value renders cleanly. */
  it('renders zero', () => {
    expect(formatNanoUsd(0n)).toBe('$0.000000')
  })

  /** Negative values render a leading minus before the symbol. */
  it('renders a negative value', () => {
    expect(formatNanoUsd(-5_000_000n)).toBe('-$0.005000')
  })

  /** A non-USD currency appends the ISO code instead of a `$` prefix. */
  it('applies an FX rate and non-USD currency', () => {
    // 1 USD = 5 BRL → $0.005 = 0.025 BRL.
    expect(formatNanoUsd(5_000_000n, { currency: 'BRL', fxRateNano: 5_000_000_000n })).toBe(
      '0.025000 BRL',
    )
  })

  /** A custom precision truncates the rendered decimals with round-half-up. */
  it('rounds to a custom decimal count', () => {
    // 1_500_000 nano = $0.0015 → 2 cents-precision digits round half up to $0.00.
    expect(formatNanoUsd(1_500_000n, { decimals: 2 })).toBe('$0.00')
    // 5_000_000 nano = $0.005 → 2-decimal round half up to $0.01.
    expect(formatNanoUsd(5_000_000n, { decimals: 2 })).toBe('$0.01')
  })

  /** Zero decimals render a whole-dollar figure with no point. */
  it('renders with zero decimals', () => {
    expect(formatNanoUsd(1_500_000_000n, { decimals: 0 })).toBe('$2')
  })

  /** The documented `[0, 9]` boundary values render without throwing. */
  it.each([0, 9])('accepts the boundary decimals value %p', (decimals) => {
    expect(() => formatNanoUsd(1_500_000n, { decimals })).not.toThrow()
  })

  /** Out-of-range or non-integer decimals throw a clear RangeError, not an obscure bigint error. */
  it.each([-1, 10, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws a RangeError on the invalid decimals %p',
    (decimals) => {
      expect(() => formatNanoUsd(1_500_000n, { decimals })).toThrow(RangeError)
    },
  )

  /** At nine decimals the render is lossless and round-trips back to the nano value. */
  it('round-trips losslessly at nine decimals', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (nano) => {
        const rendered = formatNanoUsd(nano, { decimals: 9 }).slice(1)
        const [integerText, fractionText] = rendered.split('.')
        const reconstructed = BigInt(integerText ?? '0') * 1_000_000_000n + BigInt(fractionText ?? '0')
        expect(reconstructed).toBe(nano)
      }),
    )
  })
})
