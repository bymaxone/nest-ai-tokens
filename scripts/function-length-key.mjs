/**
 * @fileoverview The identity of a function in the function-length baseline: a structured value
 * serialized as JSON, never a string joined with separators.
 * @layer scripts
 *
 * A key is `[path, segment, ..., segment]`, with a trailing integer ordinal of 2 or more when
 * several offenders share one name. Every segment is a non-empty array of strings whose first
 * element says what the segment is: `['fn', name]`, `['member', className, name]`,
 * `['ctor', className]`, `['anon']`, `['test', root, title]`, `['dynamic-test', root]`,
 * `['container', root, title]`, `['dynamic-container', root]` and `['hook', root]`; an anonymous class is
 * `<class>`, which no identifier is. Free text only ever sits inside a JSON string, and a placeholder
 * is a kind of its own, so no title, name or path can spell a delimiter, an ordinal or a
 * placeholder: two different keys cannot serialize to one string, by construction.
 */

/** The kinds of segment and how many strings each holds after its kind. */
const ARITY = new Map([
  ['fn', 1],
  ['member', 2],
  ['ctor', 1],
  ['anon', 0],
  ['test', 2],
  ['dynamic-test', 1],
  ['container', 2],
  ['dynamic-container', 1],
  ['hook', 1]
])

/**
 * Serializes a function's identity.
 *
 * @param {string} path - The tracked file, relative to the repository root.
 * @param {string[][]} segments - The enclosing and own segments, outermost first.
 * @param {number} [ordinal] - Which of several same-named offenders this is, from 1.
 * @returns {string} The key.
 */
export function encodeKey(path, segments, ordinal = 1) {
  return JSON.stringify(ordinal === 1 ? [path, ...segments] : [path, ...segments, ordinal])
}

/**
 * Reads a key back, or refuses a string that is not exactly what `encodeKey` writes.
 *
 * @param {string} key - A serialized key.
 * @returns {{ path: string, segments: string[][], ordinal: number }} The parts.
 * @throws {Error} For anything but the canonical serialization of a well-formed key.
 */
export function decodeKey(key) {
  let parsed
  try {
    parsed = JSON.parse(key)
  } catch {
    throw new Error(`${key} is not a function key`)
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') {
    throw new Error(`${key} is not a function key`)
  }
  const last = parsed[parsed.length - 1]
  const ordinal = typeof last === 'number' ? last : 1
  const segments = typeof last === 'number' ? parsed.slice(1, -1) : parsed.slice(1)
  const wellFormed =
    segments.length > 0 &&
    segments.every(
      (segment) =>
        Array.isArray(segment) &&
        segment.every((part) => typeof part === 'string') &&
        ARITY.has(segment[0]) &&
        segment.length === ARITY.get(segment[0]) + 1
    ) &&
    Number.isInteger(ordinal) &&
    ordinal >= 1
  if (!wellFormed || encodeKey(parsed[0], segments, ordinal) !== key) {
    throw new Error(`${key} is not a function key`)
  }
  return { path: parsed[0], segments, ordinal }
}

/** One segment as a person reads it. */
function render([kind, first, second]) {
  switch (kind) {
    case 'member':
      return `${first}.${second}`
    case 'ctor':
      return `${first}.constructor`
    case 'anon':
      return '<anonymous>'
    case 'dynamic-test':
    case 'dynamic-container':
      return `${first} <dynamic>`
    case 'hook':
      return `hook ${first}`
    case 'test':
    case 'container':
      return `${first} ${second}`
    default:
      return first
  }
}

/**
 * A key as a person reads it, `file::outer > inner #2`. Lossy by design: it is for messages, and
 * identity is always the key itself.
 *
 * @param {string} key - A serialized key.
 * @returns {string} The readable form.
 */
export function displayKey(key) {
  const { path, segments, ordinal } = decodeKey(key)
  return `${path}::${segments.map(render).join(' > ')}${ordinal === 1 ? '' : ` #${ordinal}`}`
}
