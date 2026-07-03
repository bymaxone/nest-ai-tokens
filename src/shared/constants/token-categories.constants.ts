/**
 * @fileoverview Catalog of the token categories that are rated independently.
 * Cache reads/writes are first-class because a naive input/output-only model
 * over-bills cached traffic by up to 10× (see spec §5.4).
 * @layer shared
 */

/** Every token category that carries its own per-million rate. */
export const TOKEN_CATEGORIES = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
  'reasoning',
  'audioIn',
  'audioOut',
  'imageIn',
  'imageOut',
] as const

/** A single rated token category. */
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number]
