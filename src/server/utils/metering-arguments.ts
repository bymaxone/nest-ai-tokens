/**
 * @fileoverview The arguments of the metering calls that take a hold, read once and by the names of their types before anything else
 * looks at them: the context and the estimate of a hold, and the hold, the caller, the usage, the preset and the content of a capture or
 * a release. What is not an object is returned as it is, for the check of the argument to refuse.
 * @layer server
 */

import type { ProviderPreset, UsageNormalizer } from '../../shared'
import type { Hold, HoldCaller, HoldEstimate, MeteringContext } from '../interfaces'
import type { RecordInput } from '../services/metering.service'
import { StreamUsageCollector } from '../streaming/stream-usage-collector'
import { newVisit, type Visit } from './argument-guards'
import { readArgument, readDatedArgument, readHoldEstimate, readShape } from './date-guards'
import { CONTENT_SHAPE, CONTEXT_SHAPE, HOLD_CALLER_SHAPE, HOLD_SHAPE, NORMALIZED_USAGE_SHAPE, PRESET_SHAPE, RECORD_SHAPE } from './input-fields'
import { isBuiltInNormalizer } from '../config/provider-presets'
import { isNormalizedUsage } from '../services/hold-support'
import { viewOf } from './usage-view'

/** The content a capture or a record may carry. */
interface Content {
  prompt?: string
  completion?: string
}

/** Whether a value is a collector of this library; a Proxy whose prototype trap throws is not one, and is read, and refused, as data. */
function isCollector(value: unknown): value is StreamUsageCollector {
  try {
    return value instanceof StreamUsageCollector
  } catch {
    return false
  }
}

/**
 * The context and the estimate of a hold, read once.
 *
 * @param context The metering context the caller passed.
 * @param estimate The estimate the caller passed.
 * @returns Their snapshots.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field that cannot be read.
 */
export function holdArguments(context: MeteringContext, estimate: HoldEstimate): { context: MeteringContext; estimate: HoldEstimate } {
  const visit = newVisit()
  return { context: readArgument(context, CONTEXT_SHAPE, 'context.', visit), estimate: readHoldEstimate(estimate, visit) }
}

/**
 * The hold and the caller of a capture or a release, read once.
 *
 * @param hold The hold the caller passed.
 * @param caller The caller the host resolved.
 * @returns Their snapshots.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field that cannot be read.
 */
export function holdOwnerArguments(hold: Hold, caller: HoldCaller): { hold: Hold; caller: HoldCaller } {
  const visit = newVisit()
  return { hold: readArgument(hold, HOLD_SHAPE, 'hold.', visit), caller: readArgument(caller, HOLD_CALLER_SHAPE, 'caller.', visit) }
}

/**
 * The usage of a call, ready for its normalizer. A usage that is already normalized is read by the names of its type, once, and is the
 * snapshot; a collector of this library is passed on as it is, since it is not data; any other is a raw response of a provider, which the
 * normalizer reads by the names of its provider, so it is handed on in a view that answers each field the same way every time and refuses
 * an object that lists no field. Anything that is not an object is returned as it is, for the check of the usage to refuse.
 *
 * @param usage What the caller passed.
 * @param visit What the call has used up, shared by every argument it reads.
 * @param normalizedFirst Whether a usage that is already normalized is recognized before the normalizer sees it.
 * @param normalizer The normalizer that will read the usage, if there is one: a host's own reads the host's object, a built-in one reads the view.
 * @returns The usage the normalizer or the settlement reads.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field that cannot be read.
 */
export function readUsage(usage: unknown, visit: Visit, normalizedFirst: boolean, normalizer: UsageNormalizer | undefined): unknown {
  if (typeof usage !== 'object' || usage === null || isCollector(usage)) return usage
  // A normalizer of the host reads the host's own object: it may call a method of it or rely on its class, and what it reads is its own business.
  // A built-in normalizer reads a view of it, so that a field it reads afterwards is the value read here.
  const source = normalizer !== undefined && !isBuiltInNormalizer(normalizer) ? usage : viewOf(usage)
  if (normalizedFirst) {
    const own = readShape(source, NORMALIZED_USAGE_SHAPE, 'usage.', visit)
    if (isNormalizedUsage(own)) return own
  }
  return source
}

/**
 * The input of a record, read once: its fields by the names of their types, its dates as valid dates, and its usage as {@link readUsage}
 * hands it on. What is not an object is returned as it is, for the check of the input to refuse.
 *
 * @param given What the caller passed.
 * @returns The snapshot of the input, or `given` itself.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field that cannot be read or is not a valid date.
 */
export function recordInput(given: RecordInput): RecordInput {
  const visit = newVisit()
  const input = readDatedArgument(given, RECORD_SHAPE, ['occurredAt'], visit)
  if (input !== given) input.usage = readUsage(input.usage, visit, (input.normalizer ?? input.preset?.normalizer) === undefined, input.normalizer ?? input.preset?.normalizer)
  return input
}

/**
 * The usage, the preset and the content of a capture, read once. A capture of a hold that is already settled returns the record it
 * posted without reading them, so they are read only once the stored hold is known to be pending.
 *
 * @param usage The raw or normalized usage; a collector of this library is passed on as it is, since it is not data.
 * @param preset The preset, when given.
 * @param content The content, when given.
 * @returns Their snapshots.
 * @throws {AiTokensException} `AI_TOKENS_INVALID_CONFIG` naming the field that cannot be read.
 */
export function captureInputs(usage: unknown, preset: ProviderPreset | undefined, content: Content | undefined): {
  usage: unknown
  preset: ProviderPreset | undefined
  content: Content | undefined
} {
  const visit = newVisit()
  const own = readArgument(preset, PRESET_SHAPE, 'preset.', visit)
  return { usage: readUsage(usage, visit, true, own?.normalizer), preset: own, content: readArgument(content, CONTENT_SHAPE, 'content.', visit) }
}
