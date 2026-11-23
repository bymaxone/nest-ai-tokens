/**
 * @fileoverview The `JSON.stringify` this module met when it loaded. A host's own tests spy on `JSON.stringify` and tracing agents wrap it, so
 * the realm guard does not compare it; the callers that import this reference turn a value into text without reading the live global.
 * @layer server
 */

/**
 * The text of a value as JSON, by the `JSON.stringify` of load time.
 *
 * @param value A JSON-serializable value.
 * @returns The JSON text.
 */
export const jsonText = JSON.stringify.bind(JSON) as (value: unknown) => string
