/**
 * @fileoverview The SQL composition of the Prisma adapter, with no dependency on Prisma. A statement is a text with
 * numbered parameters (`$1`, `$2`, …) and the values bound to them; the adapter hands both to the client's
 * `$queryRawUnsafe`/`$executeRawUnsafe`.
 * @layer prisma
 *
 * Why the unsafe-named methods are safe here: every value reaches the database as a bound parameter and never as
 * text, and the text is made only of the template's constant parts, of names that `identifier` has checked to be
 * letters and digits, and of the separators `join` accepts. There is no function that takes a string and puts it
 * into the text. The statement's shape therefore cannot depend on data. Nothing here loads Prisma, so the adapter
 * works with any major version and any generator, including a custom output.
 */

/** The separators `join` accepts. They end up in the text, so they are a closed set of constants. */
export type JoinSeparator = ',' | ', ' | ' AND '

const SEPARATORS: ReadonlySet<string> = new Set<JoinSeparator>([',', ', ', ' AND '])

/** A column name: letters and digits, starting with a letter. It cannot close a quote or start another statement. */
const COLUMN_NAME = /^[A-Za-z][A-Za-z0-9]*$/

/** A statement: the constant parts of its text and the values between them, in order. */
export class Sql {
  /** The constant parts of the text; there is one more of them than there are values. */
  readonly strings: readonly string[]
  /** The values bound to the parameters, in order. */
  readonly values: readonly unknown[]

  constructor(strings: readonly string[], values: readonly unknown[]) {
    this.strings = strings
    this.values = values
  }

  /** The text with a numbered parameter, `$1`, `$2`, …, where each value goes. */
  get text(): string {
    return this.strings.reduce((text, part, index) => `${text}$${index.toString()}${part}`)
  }
}

/** Builds a statement from constant parts and values, splicing every value that is itself a statement. */
function compose(strings: readonly string[], values: readonly unknown[]): Sql {
  const parts: string[] = []
  const bound: unknown[] = []
  let pending = ''
  const visit = (texts: readonly string[], inputs: readonly unknown[]): void => {
    texts.forEach((text, index) => {
      pending += text
      if (index === inputs.length) return
      const input = inputs[index]
      if (input instanceof Sql) {
        visit(input.strings, input.values)
      } else {
        parts.push(pending)
        pending = ''
        bound.push(input)
      }
    })
  }
  visit(strings, values)
  parts.push(pending)
  return new Sql(parts, bound)
}

/** The statement with no text and no values. */
export const empty = new Sql([''], [])

/**
 * A statement from a template: each interpolated value becomes a bound parameter, and an interpolated statement is
 * spliced in.
 *
 * @param strings The constant parts of the template.
 * @param values The interpolated values.
 * @returns The statement.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  return compose(strings, values)
}

/**
 * Joins items with a separator: a statement is spliced in, any other item becomes a bound parameter.
 *
 * @param items What to join; at least one.
 * @param separator One of the constants in {@link JoinSeparator}.
 * @returns The joined statement.
 * @throws {Error} When there is no item, or the separator is not one of the constants.
 */
export function join(items: readonly unknown[], separator: JoinSeparator = ','): Sql {
  if (!SEPARATORS.has(separator)) throw new Error('join() separator must be one of the constants')
  if (items.length === 0) throw new Error('join() needs at least one item')
  const strings = ['', ...items.slice(1).map(() => separator), '']
  return compose(strings, items)
}

/**
 * A quoted column name.
 *
 * @param name A name of letters and digits, starting with a letter.
 * @returns The quoted name, with no parameter.
 * @throws {Error} When the name is anything else.
 */
export function identifier(name: string): Sql {
  if (!COLUMN_NAME.test(name)) throw new Error(`"${name}" is not a plain column name`)
  return new Sql([`"${name}"`], [])
}

/**
 * A list of quoted column names separated by a comma and a space.
 *
 * @param names The names, each checked like {@link identifier}.
 * @returns The list, with no parameter.
 * @throws {Error} When a name is not a plain column name, or the list is empty.
 */
export function identifiers(names: readonly string[]): Sql {
  return join(names.map(identifier), ', ')
}
