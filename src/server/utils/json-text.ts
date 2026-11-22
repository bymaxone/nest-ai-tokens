/**
 * @fileoverview The `JSON.stringify` this module met when it loaded. A host's own tests spy on `JSON.stringify` and tracing agents wrap it, so
 * the realm guard does not compare it; every place that turns a value into the text of a key, a statement parameter or a report goes through
 * this reference and never through the live global.
 * @layer server
 */

/**
 * The text of a value as JSON, by the `JSON.stringify` of load time.
 *
 * @param value A JSON-serializable value.
 * @returns The JSON text.
 */
export const jsonText = JSON.stringify.bind(JSON) as (value: unknown) => string
