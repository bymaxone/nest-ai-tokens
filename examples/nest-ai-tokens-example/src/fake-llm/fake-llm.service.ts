/**
 * @fileoverview FakeLlmService — deterministic LLM-shaped responses for the example app.
 *
 * Returns realistic-looking OpenAI chat completion objects without making real API calls.
 * The usage numbers are deterministic so the example's cost calculations are predictable.
 *
 * @layer infrastructure
 */
import { Injectable } from '@nestjs/common'

/** Minimal OpenAI usage object shape. */
export interface FakeChatUsage {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly total_tokens: number
}

/** Minimal OpenAI chat completion shape. */
export interface FakeChatCompletion {
  readonly id: string
  readonly model: string
  readonly choices: Array<{ message: { role: string; content: string } }>
  readonly usage: FakeChatUsage
}

/**
 * Produces deterministic, provider-shaped LLM responses without hitting real APIs.
 * Usage counts are based on input length — useful for cost calculation smoke tests.
 */
@Injectable()
export class FakeLlmService {
  /**
   * Simulates a chat completion response.
   * Input tokens ≈ prompt length / 4; output tokens = 128 (fixed).
   *
   * @param model - Provider model identifier (e.g. 'gpt-4o').
   * @param prompt - User prompt text.
   * @returns Deterministic completion object matching the OpenAI response shape.
   */
  chatCompletion(model: string, prompt: string): FakeChatCompletion {
    const inputTokens = Math.ceil(prompt.length / 4)
    const outputTokens = 128
    return {
      id: `fake-${Date.now()}`,
      model,
      choices: [{ message: { role: 'assistant', content: `Echo: ${prompt.slice(0, 40)}...` } }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    }
  }

  /**
   * Simulates a summarization response with lower output token count.
   *
   * @param model - Provider model identifier.
   * @param text - Text to summarize.
   * @returns Deterministic completion object.
   */
  summarize(model: string, text: string): FakeChatCompletion {
    const inputTokens = Math.ceil(text.length / 4)
    const outputTokens = 64
    return {
      id: `fake-sum-${Date.now()}`,
      model,
      choices: [{ message: { role: 'assistant', content: `Summary of: ${text.slice(0, 30)}...` } }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    }
  }
}
