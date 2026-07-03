/**
 * @fileoverview Model-ID normalization for rate resolution (spec §6.6). Response
 * model ids rarely match price-row ids exactly (dated snapshots, Gemini prefixes,
 * Bedrock region prefixes), so this strips the known decorations and lowercases.
 * Pure and dependency-free.
 * @layer server
 */

/**
 * Normalize a model id: strip a `models/` prefix, a leading cloud region prefix
 * (`us.`, `eu.`, …), and a trailing date suffix (`-YYYY-MM-DD` or `-YYYYMMDD`),
 * then lowercase.
 *
 * @param id The raw model id from the response.
 * @returns The normalized id.
 * @example
 * normalizeModelId('gpt-5.2-2026-03-14')      // 'gpt-5.2'
 * normalizeModelId('models/gemini-2.5-flash') // 'gemini-2.5-flash'
 * normalizeModelId('us.anthropic.claude-opus-4') // 'anthropic.claude-opus-4'
 */
export function normalizeModelId(id: string): string {
  return id
    .trim()
    .replace(/^models\//, '')
    .replace(/^(us|eu|apac|ap|sa|ca|me|af)\./i, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .toLowerCase()
}
