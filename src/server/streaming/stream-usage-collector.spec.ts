import type { AiTokensErrorResponse } from '../../shared'
import { providerPresets } from '../config/provider-presets'
import type { AiTokensException } from '../errors'
import type { ITokenizer } from '../interfaces'
import { StreamUsageCollector } from './stream-usage-collector'

/** Read the typed error code from a thrown `AiTokensException`. */
function codeOf(error: unknown): string {
  return ((error as AiTokensException).getResponse() as AiTokensErrorResponse).error.code
}

/** A word-count tokenizer: one token per whitespace-separated word. */
const wordTokenizer: ITokenizer = {
  countTokens: ({ text }): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length),
}

describe('StreamUsageCollector', () => {
  /** An OpenAI stream whose trailing chunk carries usage wins over the tokenizer. */
  it('prefers the OpenAI provider-final usage', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.push({ choices: [{ delta: { content: 'Hello' } }], usage: null })
    collector.push({ choices: [{ delta: { content: ' world' } }], usage: null })
    collector.push({ model: 'gpt-5', choices: [], usage: { prompt_tokens: 40, completion_tokens: 12 } })
    const usage = await collector.finalize()
    expect(usage.inputTokens).toBe(40)
    expect(usage.outputTokens).toBe(12)
    expect(collector.usedFallback).toBe(false)
  })

  /** An Anthropic stream finalized at message_stop reads cumulative output tokens. */
  it('finalizes an Anthropic cumulative stream', async () => {
    const collector = new StreamUsageCollector({ provider: 'anthropic', model: 'claude-opus' })
    collector.push({ type: 'message_start', message: { model: 'claude-opus-4', usage: { input_tokens: 100, output_tokens: 1 } } })
    collector.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } })
    collector.push({ type: 'message_delta', usage: { output_tokens: 25 } })
    collector.push({ type: 'message_delta', usage: { output_tokens: 42 } })
    collector.push({ type: 'message_stop' })
    const usage = await collector.finalize()
    expect(usage.provider).toBe('anthropic')
    expect(usage.model).toBe('claude-opus-4')
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(42)
  })

  /** An aborted stream with a tokenizer bills the counted partial output; input from the prompt count. */
  it('bills tokenizer-counted output on an abort', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.setPromptTokens(80)
    collector.push({ choices: [{ delta: { content: 'one two' } }] })
    collector.push({ choices: [{ delta: { content: ' three' } }] })
    const usage = await collector.finalize()
    expect(collector.usedFallback).toBe(true)
    expect(usage.outputTokens).toBe(3)
    expect(usage.inputTokens).toBe(80)
  })

  /** An abort with prompt TEXT counts the input via the tokenizer. */
  it('counts input from prompt text on an abort', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.setPromptText('a b c d')
    collector.push({ choices: [{ delta: { content: 'x' } }] })
    const usage = await collector.finalize()
    expect(usage.inputTokens).toBe(4)
    expect(usage.outputTokens).toBe(1)
  })

  /** An abort with no prompt info leaves input at 0 (capture applies the hold estimate). */
  it('leaves input at zero without prompt info', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.push({ choices: [{ delta: { content: 'hi there' } }] })
    const usage = await collector.finalize()
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(2)
  })

  /** No tokenizer and no final usage → STREAM_USAGE_MISSING (422). */
  it('throws STREAM_USAGE_MISSING without a tokenizer or final usage', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5' })
    collector.push({ choices: [{ delta: { content: 'hi' } }] })
    const error = await collector.finalize().catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_STREAM_USAGE_MISSING')
    expect((error as AiTokensException).getStatus()).toBe(422)
  })

  /** finalize() is single-use. */
  it('rejects a second finalize', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.push({ choices: [{ delta: { content: 'hi' } }] })
    await collector.finalize()
    const error = await collector.finalize().catch((e: unknown) => e)
    expect(codeOf(error)).toBe('AI_TOKENS_STREAM_USAGE_MISSING')
  })

  /** push() never throws on malformed chunks; they are counted. */
  it('skips and counts malformed chunks', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.push(null)
    collector.push('not an object')
    collector.push({ choices: 'not-an-array' })
    collector.push({ choices: [{ delta: { content: 'ok' } }] })
    expect(collector.malformedCount).toBe(2)
    const usage = await collector.finalize()
    expect(usage.outputTokens).toBe(1)
  })

  /** A preset overrides the built-in normalizer for the final usage. */
  it('uses the preset normalizer for the final usage', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', preset: providerPresets.openaiChat })
    collector.push({ model: 'gpt-5', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    const usage = await collector.finalize()
    expect(usage.inputTokens).toBe(10)
    expect(usage.outputTokens).toBe(5)
  })

  /** A custom output extractor is used for a non-built-in provider. */
  it('uses a custom output extractor', async () => {
    const collector = new StreamUsageCollector({
      provider: 'deepseek',
      model: 'deepseek-chat',
      tokenizer: wordTokenizer,
      outputText: (chunk) => (typeof chunk.text === 'string' ? chunk.text : undefined),
    })
    collector.push({ text: 'alpha beta' })
    const usage = await collector.finalize()
    expect(usage.outputTokens).toBe(2)
  })

  /** A throwing extractor during push is caught and counted, never propagated. */
  it('counts a chunk whose extractor throws', async () => {
    const collector = new StreamUsageCollector({
      provider: 'openai',
      model: 'gpt-5',
      tokenizer: wordTokenizer,
      outputText: () => {
        throw new Error('extractor boom')
      },
    })
    expect(() => collector.push({ choices: [{ delta: { content: 'x' } }] })).not.toThrow()
    expect(collector.malformedCount).toBe(1)
  })

  /** An Anthropic abort before message_stop falls back to the tokenizer. */
  it('falls back on an Anthropic abort before message_stop', async () => {
    const collector = new StreamUsageCollector({ provider: 'anthropic', model: 'claude-opus', tokenizer: wordTokenizer })
    collector.push({ type: 'message_start', message: { model: 'claude-opus-4', usage: { input_tokens: 50, output_tokens: 1 } } })
    collector.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial answer' } })
    const usage = await collector.finalize()
    expect(collector.usedFallback).toBe(true)
    expect(usage.outputTokens).toBe(2)
  })

  /** An Anthropic stream tolerates a modelless start, a textless delta, and a usageless delta. */
  it('tolerates partial Anthropic events', async () => {
    const collector = new StreamUsageCollector({ provider: 'anthropic', model: 'claude-x' })
    collector.push({ type: 'ping' }) // unrecognized event type → ignored
    collector.push({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 2 } } }) // no model → falls back to opts.model
    collector.push({ type: 'content_block_delta', delta: {} }) // no text
    collector.push({ type: 'content_block_delta', delta: { text: 'hi' } })
    collector.push({ type: 'message_delta', other: 1 }) // no usage
    collector.push({ type: 'message_delta', usage: { output_tokens: Number.POSITIVE_INFINITY } }) // non-finite → 0
    collector.push({ type: 'message_delta', usage: { output_tokens: 9 } })
    collector.push({ type: 'message_stop' })
    const usage = await collector.finalize()
    expect(usage.model).toBe('claude-x')
    expect(usage.inputTokens).toBe(50)
    expect(usage.outputTokens).toBe(9)
  })

  /** An Anthropic start without usage still aborts cleanly to the tokenizer. */
  it('falls back when the Anthropic start omits usage', async () => {
    const collector = new StreamUsageCollector({ provider: 'anthropic', model: 'claude-x', tokenizer: wordTokenizer })
    collector.push({ type: 'message_start', message: { model: 'claude-y' } })
    collector.push({ type: 'content_block_delta', delta: { text: 'one two three' } })
    const usage = await collector.finalize()
    expect(collector.usedFallback).toBe(true)
    expect(usage.outputTokens).toBe(3)
  })

  /** An OpenAI chunk with an empty/absent delta content contributes no output text. */
  it('ignores OpenAI chunks with no delta content', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.push({ choices: [{}] }) // no delta
    collector.push({ choices: [{ delta: {} }] }) // delta without content
    collector.push({ choices: [{ delta: { content: 'word' } }] })
    const usage = await collector.finalize()
    expect(usage.outputTokens).toBe(1)
  })

  /**
   * A textless OpenAI chunk must NOT append anything to the accumulated output. Kills
   * the L150 ConditionalExpression → true on `if (text !== undefined)`: with the guard
   * forced true, `outputText += undefined` appends the literal string 'undefined'. The
   * intentional trailing space on the first chunk makes that a separate token, so the
   * tokenizer fallback would count 2 instead of 1.
   */
  it('does not append output for a textless OpenAI chunk', async () => {
    const collector = new StreamUsageCollector({ provider: 'openai', model: 'gpt-5', tokenizer: wordTokenizer })
    collector.push({ choices: [{ delta: { content: 'hi ' } }] }) // trailing space is intentional
    collector.push({ choices: [{}] }) // no delta content → text is undefined
    const usage = await collector.finalize()
    expect(collector.usedFallback).toBe(true)
    expect(usage.outputTokens).toBe(1)
  })

  /**
   * A textless Anthropic content_block_delta must NOT append anything to the output.
   * Kills the L166 ConditionalExpression → true on `if (text !== undefined)`: forcing
   * the guard true appends the literal 'undefined' via `outputText += undefined`. The
   * abort (no message_stop) routes through the tokenizer fallback so the accumulated
   * text is what gets counted — 1 token, not 2.
   */
  it('does not append output for a textless Anthropic delta', async () => {
    const collector = new StreamUsageCollector({ provider: 'anthropic', model: 'claude-x', tokenizer: wordTokenizer })
    collector.push({ type: 'content_block_delta', delta: { text: 'hi ' } }) // trailing space is intentional
    collector.push({ type: 'content_block_delta', delta: {} }) // no text → text is undefined
    const usage = await collector.finalize()
    expect(collector.usedFallback).toBe(true)
    expect(usage.outputTokens).toBe(1)
  })

  /**
   * Only a `message_stop` event finalizes the Anthropic response. Kills the L170
   * ConditionalExpression → true on `else if (type === 'message_stop')`: forcing it true
   * makes any non-terminal event (here a `ping`) synthesize a provider-final response
   * from the partial state, so finalize() would report the provider counts (input 50,
   * output 3) with no fallback instead of the tokenizer-counted partial output.
   */
  it('does not finalize on a non-message_stop Anthropic event', async () => {
    const collector = new StreamUsageCollector({ provider: 'anthropic', model: 'claude-x', tokenizer: wordTokenizer })
    collector.push({ type: 'message_start', message: { model: 'claude-y', usage: { input_tokens: 50, output_tokens: 3 } } })
    collector.push({ type: 'content_block_delta', delta: { text: 'partial' } })
    collector.push({ type: 'ping' }) // not message_stop → must not finalize
    const usage = await collector.finalize()
    expect(collector.usedFallback).toBe(true)
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(1)
  })
})
