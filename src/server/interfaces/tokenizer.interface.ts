/**
 * @fileoverview The token-estimation port (spec §14.2.1). Used by `hold()`
 * pre-flight estimation and the aborted-stream fallback (§5.6). The library ships
 * no tokenizer — the host plugs one in (tiktoken, provider count-tokens, …).
 * @layer server
 */

import type { ProviderId } from '../../shared'

/** A host-plugged token counter. */
export interface ITokenizer {
  /** Count the tokens `text` consumes for the given model/provider (sync or async). */
  countTokens(input: { text: string; model?: string; provider?: ProviderId }): number | Promise<number>
}
