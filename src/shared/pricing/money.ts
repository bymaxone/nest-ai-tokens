/**
 * @fileoverview Exact nano-USD money helpers. Every persisted monetary value is
 * an integer number of nano-USD (`1e-9` USD) held as a `bigint`, so all
 * arithmetic is exact integer math. Floating point appears only at the two
 * documented boundaries: the OpenRouter `usage.cost` entry conversion
 * ({@link floatUsdToNanoUsd}) and presentation ({@link formatNanoUsd}).
 * @layer shared
 */

/** Nano-USD in one whole USD unit (`1e9`). */
const NANO_PER_USD = 1_000_000_000n

/** Default number of fractional digits rendered by {@link formatNanoUsd}. */
const DEFAULT_DISPLAY_DECIMALS = 6

/**
 * The building block for token pricing: cost of `tokens` at a rate expressed as
 * nano-USD per 1,000,000 tokens, as exact integer math (spec §7.1).
 *
 * @param tokens Integer token count.
 * @param ratePerMillionNano Rate in nano-USD per 1,000,000 tokens.
 * @returns Cost in nano-USD, truncated toward zero on the division.
 * @example
 * perMillion(1000, 5_000_000_000n) // 5_000_000n  ($0.005 for 1k tokens at $5/M)
 */
export function perMillion(tokens: number, ratePerMillionNano: bigint): bigint {
  return (BigInt(tokens) * ratePerMillionNano) / 1_000_000n
}

/**
 * Convert a floating-point USD amount (e.g. OpenRouter `usage.cost`) into
 * nano-USD, rounding half away from zero at nano precision. The dollar and
 * fractional parts are handled separately so no product overflows the 2^53
 * exact-integer range: the result is exact for `|usd| < $1,000` (and for any
 * value whose fractional dollars round cleanly). This is the only float→bigint
 * entry point on a money path.
 *
 * @param usd The amount in USD.
 * @returns The amount in nano-USD.
 * @throws {RangeError} When `usd` is not finite.
 * @example
 * floatUsdToNanoUsd(0.005) // 5_000_000n
 */
export function floatUsdToNanoUsd(usd: number): bigint {
  if (!Number.isFinite(usd)) {
    throw new RangeError(`floatUsdToNanoUsd: expected a finite number, received ${String(usd)}`)
  }
  const sign = usd < 0 ? -1n : 1n
  const abs = Math.abs(usd)
  const wholeDollars = Math.floor(abs)
  const fractionalDollars = abs - wholeDollars
  const wholeNano = BigInt(wholeDollars) * NANO_PER_USD
  const fractionalNano = BigInt(Math.round(fractionalDollars * 1e9))
  return sign * (wholeNano + fractionalNano)
}

/** Options controlling how {@link formatNanoUsd} renders a value. */
export interface FormatNanoUsdOptions {
  /** ISO currency code; `'USD'` renders a `$` prefix, others append the code. Default `'USD'`. */
  currency?: string
  /** Presentation FX rate as target-currency nano-units per 1 USD; converts at read time. */
  fxRateNano?: bigint
  /** Fractional digits to render, in the range `[0, 9]`. Default `6`. */
  decimals?: number
}

/**
 * Render a nano-USD value as a human-readable currency string. Presentation
 * only — rounding to the displayed precision is round-half-up computed in
 * `bigint`, never floating point (spec §7.4).
 *
 * @param nanoUsd The value in nano-USD.
 * @param opts Currency, FX, and precision options.
 * @returns The formatted string, e.g. `"$0.005000"`.
 * @example
 * formatNanoUsd(5_000_000n)                               // '$0.005000'
 * formatNanoUsd(5_000_000n, { currency: 'BRL', fxRateNano: 5_000_000_000n }) // '0.025000 BRL'
 */
export function formatNanoUsd(nanoUsd: bigint, opts?: FormatNanoUsdOptions): string {
  const decimals = opts?.decimals ?? DEFAULT_DISPLAY_DECIMALS
  const currency = opts?.currency ?? 'USD'

  const converted = opts?.fxRateNano == null ? nanoUsd : (nanoUsd * opts.fxRateNano) / NANO_PER_USD

  const negative = converted < 0n
  const magnitude = negative ? -converted : converted

  // Round the nano value to `decimals` places (round-half-up on the magnitude).
  const nanoPerDisplayUnit = 10n ** BigInt(9 - decimals)
  const displayUnits = (magnitude + nanoPerDisplayUnit / 2n) / nanoPerDisplayUnit

  const scale = 10n ** BigInt(decimals)
  const integerPart = displayUnits / scale
  const fractionalPart = displayUnits % scale
  const fractionalText = decimals > 0 ? `.${fractionalPart.toString().padStart(decimals, '0')}` : ''
  const body = `${integerPart.toString()}${fractionalText}`
  const signText = negative ? '-' : ''

  return currency === 'USD' ? `${signText}$${body}` : `${signText}${body} ${currency}`
}
