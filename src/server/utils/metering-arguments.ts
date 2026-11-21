/**
 * @fileoverview The arguments of the metering calls that take a hold, read once and by the names of their types before anything else
 * looks at them: the context and the estimate of a hold, and the hold, the caller, the usage, the preset and the content of a capture or
 * a release. What is not an object is returned as it is, for the check of the argument to refuse.
 * @layer server
 */

import type { ProviderPreset } from '../../shared'
import type { Hold, HoldCaller, HoldEstimate, MeteringContext } from '../interfaces'
import { StreamUsageCollector } from '../streaming/stream-usage-collector'
import { MAX_USAGE_NESTING, readDeep } from './argument-guards'
import { readArgument, readHoldEstimate } from './date-guards'
import { CONTENT_SHAPE, CONTEXT_SHAPE, HOLD_CALLER_SHAPE, HOLD_SHAPE, PRESET_SHAPE } from './input-fields'

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
  return { context: readArgument(context, CONTEXT_SHAPE, 'context.'), estimate: readHoldEstimate(estimate) }
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
  return { hold: readArgument(hold, HOLD_SHAPE, 'hold.'), caller: readArgument(caller, HOLD_CALLER_SHAPE, 'caller.') }
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
  return { usage: isCollector(usage) ? usage : readDeep(usage, 'usage', 0, MAX_USAGE_NESTING), preset: readArgument(preset, PRESET_SHAPE, 'preset.'), content: readArgument(content, CONTENT_SHAPE, 'content.') }
}
