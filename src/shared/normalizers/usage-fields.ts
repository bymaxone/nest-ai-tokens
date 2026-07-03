/**
 * @fileoverview Internal field-reading helpers shared by the provider
 * normalizers, plus the {@link buildUsage} factory that centralizes numeric
 * defaults and optional-field handling for {@link NormalizedUsage}. Pure and
 * dependency-free; not exported from the public barrel.
 * @layer shared
 */

import { SERVICE_TIERS } from '../constants/service-tiers.constants'
import type { ServiceTier } from '../constants/service-tiers.constants'
import type { AiOperation } from '../constants/operations.constants'
import type { ProviderId } from '../types/catalogs'
import type { NormalizedUsage } from '../types/normalized-usage'

/** Narrow an unknown to a plain (non-array) object, or `undefined`. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Narrow an unknown to an array, or `undefined`. */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/** Read an optional finite token count; anything else becomes `0`. */
export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Read a required finite token count; throw a plain Error when absent/invalid. */
export function requireNum(value: unknown, provider: string, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error(`${provider}: missing or invalid numeric field "${field}"`)
}

/** Read a string value, or `undefined`. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Map a value to a known {@link ServiceTier}, or `undefined` when unrecognized. */
export function knownServiceTier(value: unknown): ServiceTier | undefined {
  const candidate = str(value)
  return candidate !== undefined && (SERVICE_TIERS as readonly string[]).includes(candidate)
    ? (candidate as ServiceTier)
    : undefined
}

/** Map an OpenAI-style service tier, treating the silent-downgrade `'default'` as `'standard'`. */
export function openAiServiceTier(value: unknown): ServiceTier | undefined {
  const candidate = str(value)
  return knownServiceTier(candidate === 'default' ? 'standard' : candidate)
}

/** Extract the finite numeric entries of a server-tool-use object, or `undefined` when empty. */
export function toolUseCounts(value: unknown): Record<string, number> | undefined {
  const source = asObject(value)
  if (source === undefined) return undefined
  const counts: Record<string, number> = {}
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) counts[key] = raw
  }
  return Object.keys(counts).length > 0 ? counts : undefined
}

/** The fields {@link buildUsage} accepts; numeric categories default to `0`. */
export interface UsageDraft {
  provider: ProviderId
  model: string
  operation: AiOperation
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number | undefined
  cacheWrite5mTokens?: number | undefined
  cacheWrite1hTokens?: number | undefined
  reasoningTokens?: number | undefined
  audioInTokens?: number | undefined
  audioOutTokens?: number | undefined
  imageInTokens?: number | undefined
  imageOutTokens?: number | undefined
  serviceTier?: ServiceTier | undefined
  serverToolUse?: Record<string, number> | undefined
  providerReportedCostNanoUsd?: bigint | undefined
  raw?: Record<string, unknown> | undefined
}

/**
 * Build a {@link NormalizedUsage} from a draft: fill every numeric category with
 * `0` when absent and include the optional fields only when defined (honoring
 * `exactOptionalPropertyTypes`).
 */
export function buildUsage(draft: UsageDraft): NormalizedUsage {
  const usage: NormalizedUsage = {
    provider: draft.provider,
    model: draft.model,
    operation: draft.operation,
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
    cacheReadTokens: draft.cacheReadTokens ?? 0,
    cacheWrite5mTokens: draft.cacheWrite5mTokens ?? 0,
    cacheWrite1hTokens: draft.cacheWrite1hTokens ?? 0,
    reasoningTokens: draft.reasoningTokens ?? 0,
    audioInTokens: draft.audioInTokens ?? 0,
    audioOutTokens: draft.audioOutTokens ?? 0,
    imageInTokens: draft.imageInTokens ?? 0,
    imageOutTokens: draft.imageOutTokens ?? 0,
  }
  if (draft.serviceTier !== undefined) usage.serviceTier = draft.serviceTier
  if (draft.serverToolUse !== undefined) usage.serverToolUse = draft.serverToolUse
  if (draft.providerReportedCostNanoUsd !== undefined) {
    usage.providerReportedCostNanoUsd = draft.providerReportedCostNanoUsd
  }
  if (draft.raw !== undefined) usage.raw = draft.raw
  return usage
}

/** A provider response object paired with its required usage sub-object. */
export interface ResponseAndUsage {
  response: Record<string, unknown>
  usage: Record<string, unknown>
}

/**
 * Read a provider response and its required usage sub-object. The response is
 * needed for top-level fields (model, service tier); the usage sub-object for
 * token counts. Throws a plain Error when the usage object is absent.
 */
export function readResponse(raw: unknown, provider: string, usageKey = 'usage'): ResponseAndUsage {
  const response = asObject(raw) ?? {}
  const usage = asObject(response[usageKey])
  if (usage === undefined) throw new Error(`${provider}: missing "${usageKey}" object`)
  return { response, usage }
}
