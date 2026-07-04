import { normalizeModelId } from './model-id'

describe('normalizeModelId', () => {
  /** A trailing ISO date snapshot suffix is stripped (the §6.6 OpenAI example). */
  it('strips a -YYYY-MM-DD date suffix', () => {
    expect(normalizeModelId('gpt-5.2-2026-03-14')).toBe('gpt-5.2')
  })

  /** A compact date suffix is stripped too. */
  it('strips a -YYYYMMDD date suffix', () => {
    expect(normalizeModelId('gpt-5.2-20260314')).toBe('gpt-5.2')
  })

  /** The Gemini `models/` prefix is stripped. */
  it('strips a models/ prefix', () => {
    expect(normalizeModelId('models/gemini-2.5-flash')).toBe('gemini-2.5-flash')
  })

  /** A Bedrock region prefix is stripped. */
  it('strips a cloud region prefix', () => {
    expect(normalizeModelId('us.anthropic.claude-opus-4')).toBe('anthropic.claude-opus-4')
  })

  /** Prefix, region, and date decorations combine and the result is lowercased. */
  it('combines strips and lowercases', () => {
    expect(normalizeModelId('EU.Gemini-2.5-Pro-2026-01-31')).toBe('gemini-2.5-pro')
  })

  /** An already-clean id is returned lowercased and trimmed. */
  it('returns a clean id unchanged (lowercased)', () => {
    expect(normalizeModelId('  GPT-5  ')).toBe('gpt-5')
    expect(normalizeModelId('claude-3-5-sonnet')).toBe('claude-3-5-sonnet')
  })

  /** Only the leading `models/` prefix is stripped — not an embedded occurrence (kills Regex mutation removing the `^` anchor). */
  it('does not strip models/ when it appears mid-string', () => {
    expect(normalizeModelId('not-models/foo')).toBe('not-models/foo')
  })

  /** Only a leading region prefix is stripped — not an embedded `us.` (kills Regex mutation removing the `^` anchor). */
  it('does not strip a region prefix when it appears mid-string', () => {
    expect(normalizeModelId('claude.us.model')).toBe('claude.us.model')
  })

  /** Only a TRAILING date suffix is stripped — a date in the middle is preserved (kills Regex mutation removing the `$` anchor). */
  it('does not strip a date when it is not at the end', () => {
    // Date appears before a non-date suffix — original regex anchored at $, mutation removes the anchor.
    expect(normalizeModelId('gpt-2026-03-14-turbo')).toBe('gpt-2026-03-14-turbo')
    expect(normalizeModelId('gpt-20260314-turbo')).toBe('gpt-20260314-turbo')
  })
})
