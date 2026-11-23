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

/** Whether a value is a count a provider can report: a whole number from 0 to `Number.MAX_SAFE_INTEGER`. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Read an optional token count: absent (`undefined`, or `null` as JSON writes it) is `0`; a value that is there must be a count, a whole
 * number from 0 to `Number.MAX_SAFE_INTEGER`, and anything else (a string, `NaN`, a negative, a fraction, an object) throws, because a count
 * that is read as `0` bills a call for less than it used.
 */
export function num(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (isCount(value)) return value
  throw new Error('a count of the usage is not a whole number from 0 to the largest safe integer')
}

/** Read a required token count; throw a plain Error when absent or not a count (see {@link num}). */
export function requireNum(value: unknown, provider: string, field: string): number {
  if (isCount(value)) return value
  throw new Error(`${provider}: missing or invalid count "${field}"`)
}

/**
 * Read a container of counts: absent (`undefined` or `null`) is `undefined`; a plain object is itself; anything else (an array, a string,
 * a number) throws, because a container that is read as absent drops the counts it holds.
 */
export function detailsObject(value: unknown, provider: string, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  const object = asObject(value)
  if (object !== undefined) return object
  throw new Error(`${provider}: "${field}" must be an object`)
}

/** Read a list of counts' containers: absent is `undefined`; a list is itself; anything else throws (see {@link detailsObject}). */
export function detailsArray(value: unknown, provider: string, field: string): unknown[] | undefined {
  if (value === undefined || value === null) return undefined
  const list = asArray(value)
  if (list !== undefined) return list
  throw new Error(`${provider}: "${field}" must be a list`)
}

/**
 * A count that a response may report in two places, such as at the root of the usage and again in a details object: the same tokens
 * under two names, so they are billed once. One that is there alone is that count; two that are there and agree are one count; two that
 * are there and differ cannot both be right, and are refused rather than added or picked between.
 */
export function aliasCount(first: unknown, second: unknown, provider: string, field: string): number {
  const left = num(first)
  const right = num(second)
  if (first === undefined || first === null) return right
  if (second === undefined || second === null) return left
  if (left === right) return left
  throw new Error(`${provider}: "${field}" is reported twice and the two counts differ`)
}

/** The sum of counts, which must itself be a count: two counts a provider reports cannot add up past the largest safe integer. */
export function sumCounts(...counts: number[]): number {
  const sum = counts.reduce((total, count) => total + count, 0)
  if (!isCount(sum)) throw new Error('the counts of the usage add up past the largest safe integer')
  return sum
}

/**
 * What is left of a total once its parts are taken out: a cached, audio or reasoning part is a part of the tokens the provider counted, so
 * parts that are more than their total are a usage that cannot be, and throw, where a clamp would have billed the call as another.
 */
export function remainder(total: number, parts: number[], provider: string, field: string): number {
  const left = total - sumCounts(...parts)
  if (left < 0) throw new Error(`${provider}: the parts of "${field}" are more than the whole`)
  return left
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

/** Extract the counts of a server-tool-use object, or `undefined` when there is none: an entry that is there must be a count (see {@link num}). */
export function toolUseCounts(value: unknown, provider: string): Record<string, number> | undefined {
  const source = detailsObject(value, provider, 'server_tool_use')
  if (source === undefined) return undefined
  const counts: Record<string, number> = {}
  for (const [key, raw] of Object.entries(source)) {
    if (raw !== undefined && raw !== null) counts[key] = num(raw)
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
 * What a draft sets for `key` itself: a draft is an object literal that leaves optional names out, and a name it lacks is answered by the
 * `Object.prototype` of its realm, where another library, or prototype pollution, may have put a key.
 */
function own<K extends keyof UsageDraft>(draft: UsageDraft, key: K): UsageDraft[K] | undefined {
  return Object.hasOwn(draft, key) ? draft[key] : undefined
}

/**
 * Build a {@link NormalizedUsage} from a draft: fill every numeric category with
 * `0` when absent and include the optional fields only when defined (honoring
 * `exactOptionalPropertyTypes`). Every name of the draft is read as the draft's own, and the usage has no prototype, so a name it lacks is
 * `undefined` wherever it is read and never a key planted on `Object.prototype`.
 */
export function buildUsage(draft: UsageDraft): NormalizedUsage {
  const usage: NormalizedUsage = Object.assign(Object.create(null) as NormalizedUsage, {
    provider: draft.provider,
    model: draft.model,
    operation: draft.operation,
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
    cacheReadTokens: own(draft, 'cacheReadTokens') ?? 0,
    cacheWrite5mTokens: own(draft, 'cacheWrite5mTokens') ?? 0,
    cacheWrite1hTokens: own(draft, 'cacheWrite1hTokens') ?? 0,
    reasoningTokens: own(draft, 'reasoningTokens') ?? 0,
    audioInTokens: own(draft, 'audioInTokens') ?? 0,
    audioOutTokens: own(draft, 'audioOutTokens') ?? 0,
    imageInTokens: own(draft, 'imageInTokens') ?? 0,
    imageOutTokens: own(draft, 'imageOutTokens') ?? 0,
  })
  const serviceTier = own(draft, 'serviceTier')
  const serverToolUse = own(draft, 'serverToolUse')
  const providerReportedCostNanoUsd = own(draft, 'providerReportedCostNanoUsd')
  const raw = own(draft, 'raw')
  if (serviceTier !== undefined) usage.serviceTier = serviceTier
  if (serverToolUse !== undefined) usage.serverToolUse = serverToolUse
  if (providerReportedCostNanoUsd !== undefined) usage.providerReportedCostNanoUsd = providerReportedCostNanoUsd
  if (raw !== undefined) usage.raw = raw
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
