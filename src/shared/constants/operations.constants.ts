/**
 * @fileoverview Catalog of AI operation kinds a usage record can describe. The
 * operation is part of the price-resolution key; `'responses'` bills identically
 * to `'chat'` and shares its price rows (see spec §5.1).
 * @layer shared
 */

/** Every operation kind the library can meter and price. */
export const AI_OPERATIONS = [
  'chat',
  'responses',
  'embeddings',
  'image',
  'video',
  'audio',
  'rerank',
  'moderation',
] as const

/** A logical AI operation kind. */
export type AiOperation = (typeof AI_OPERATIONS)[number]
