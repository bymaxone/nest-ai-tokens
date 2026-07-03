/**
 * @fileoverview Catalog of the AI providers this library recognizes out of the
 * box. Custom OpenAI-compatible providers register their own id at runtime via
 * `providerPresets.openaiCompatible(id)`, so the public {@link ProviderId} type
 * (see `types/catalogs.ts`) widens this closed list with `(string & {})`.
 * @layer shared
 */

/**
 * The provider identifiers shipped with the library. Frozen tuple so the derived
 * {@link KnownProviderId} union stays in sync with the runtime values.
 */
export const PROVIDER_IDS = [
  'openai',
  'azure-openai',
  'anthropic',
  'gemini',
  'vertex',
  'mistral',
  'bedrock',
  'openrouter',
  'deepseek',
  'xai',
  'groq',
] as const

/** A provider id known to the library at build time (excludes custom ids). */
export type KnownProviderId = (typeof PROVIDER_IDS)[number]
