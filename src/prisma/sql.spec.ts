/**
 * @fileoverview Unit tests for the SQL composition of the Prisma adapter: the tagged template, nesting, joins and
 * the two ways a name reaches the text.
 * @layer prisma
 *
 * Every value is a bound parameter and the text is built from constants only; these tests pin that, because the
 * adapter hands the text to the client's unsafe-named raw methods.
 */

import { Sql, empty, identifier, identifiers, join, sql } from './sql'

describe('sql', () => {
  /** Every interpolated value becomes a numbered parameter; the text holds only the constants and `$n`. */
  it('numbers the parameters in order and keeps the values apart from the text', () => {
    const query = sql`SELECT * FROM t WHERE a = ${'x'} AND b = ${2n} AND c = ${null}`
    expect(query.text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3')
    expect(query.values).toEqual(['x', 2n, null])
  })

  /** A template without a value has no parameter. */
  it('builds a constant text with no values', () => {
    const query = sql`SELECT 1`
    expect(query).toBeInstanceOf(Sql)
    expect(query.text).toBe('SELECT 1')
    expect(query.values).toEqual([])
  })

  /** A value is never read as SQL, whatever it contains: it stays out of the text. */
  it('keeps a value that looks like SQL out of the text', () => {
    const hostile = `x'; DROP TABLE ai_usage_records; --`
    const query = sql`SELECT * FROM t WHERE a = ${hostile}`
    expect(query.text).toBe('SELECT * FROM t WHERE a = $1')
    expect(query.values).toEqual([hostile])
  })

  /** Dates, booleans and arrays are single parameters, not expanded. */
  it('binds a date, a boolean and an array as one parameter each', () => {
    const at = new Date('2026-06-01T00:00:00.000Z')
    const query = sql`${at} ${true} ${['a', 'b']}::text[]`
    expect(query.text).toBe('$1 $2 $3::text[]')
    expect(query.values).toEqual([at, true, ['a', 'b']])
  })

  /** A fragment embedded in another is spliced in, and the numbering continues across it. */
  it('splices a nested fragment and renumbers across it', () => {
    const inner = sql`b = ${2} AND c = ${3}`
    const query = sql`a = ${1} AND ${inner} AND d = ${4}`
    expect(query.text).toBe('a = $1 AND b = $2 AND c = $3 AND d = $4')
    expect(query.values).toEqual([1, 2, 3, 4])
  })

  /** A fragment with no value of its own adds text and no parameter. */
  it('splices a constant fragment', () => {
    const clock = sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`
    const query = sql`SET at = ${clock}, by = ${'u'}`
    expect(query.text).toBe(`SET at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), by = $1`)
    expect(query.values).toEqual(['u'])
  })

  /** The empty fragment disappears from the text and adds nothing. */
  it('splices the empty fragment as nothing', () => {
    expect(empty.text).toBe('')
    expect(empty.values).toEqual([])
    expect(sql`a ${empty}b ${1}`.text).toBe('a b $1')
  })

  /** A nested fragment keeps its own values and does not change when it is embedded. */
  it('leaves the embedded fragment as it was', () => {
    const inner = sql`x = ${1}`
    const outer = sql`${inner} AND y = ${2}`
    expect(outer.values).toEqual([1, 2])
    expect(inner.text).toBe('x = $1')
    expect(inner.values).toEqual([1])
  })
})

describe('join', () => {
  /** The default separator is a comma; plain values become parameters. */
  it('joins values with a comma by default', () => {
    const joined = join(['a', 'b', 'c'])
    expect(joined.text).toBe('$1,$2,$3')
    expect(joined.values).toEqual(['a', 'b', 'c'])
  })

  /** Fragments are spliced, and the other two separators are allowed. */
  it('joins fragments with the separators the adapter uses', () => {
    const parts = [sql`a = ${1}`, sql`b = ${2}`]
    expect(join(parts, ' AND ').text).toBe('a = $1 AND b = $2')
    expect(join(parts, ', ').text).toBe('a = $1, b = $2')
    expect(join(parts, ', ').values).toEqual([1, 2])
  })

  /** One item is that item, with no separator. */
  it('joins a single item without a separator', () => {
    expect(join([sql`only = ${1}`], ' AND ').text).toBe('only = $1')
  })

  /** A join with nothing to join is a mistake, not an empty text. */
  it('refuses an empty list', () => {
    expect(() => join([])).toThrow('join() needs at least one item')
  })

  /** The separator is part of the text, so only the constants the adapter uses are accepted. */
  it('refuses a separator that is not one of the constants', () => {
    // The type already refuses these; Reflect.apply passes them as a caller outside the type system could.
    const callJoin = (separator: string): unknown => Reflect.apply(join, undefined, [['a', 'b'], separator])
    expect(() => callJoin('; DROP TABLE x; --')).toThrow('join() separator')
    expect(() => callJoin(' OR ')).toThrow('join() separator')
  })
})

describe('identifier', () => {
  /** A name that is letters and digits, starting with a letter, is quoted and adds no parameter. */
  it('quotes a plain name', () => {
    const quoted = identifier('billedCostNanoUsd')
    expect(quoted.text).toBe('"billedCostNanoUsd"')
    expect(quoted.values).toEqual([])
    expect(identifier('cacheWrite5mTokens').text).toBe('"cacheWrite5mTokens"')
  })

  /** Anything that could close the quote or start another statement cannot become text. */
  it.each([
    ['an empty name', ''],
    ['a quote', 'a"b'],
    ['a space', 'a b'],
    ['a semicolon', 'a;b'],
    ['a dash', 'a-b'],
    ['a dot', 'a.b'],
    ['a leading digit', '1a'],
    ['an underscore', 'a_b'],
    ['a newline after a valid name', 'ab\n'],
  ])('refuses %s', (_label, name) => {
    expect(() => identifier(name)).toThrow('is not a plain column name')
  })

  /** A list of names is quoted and joined, with the same check on each. */
  it('quotes a list of names', () => {
    expect(identifiers(['id', 'tenantId', 'status']).text).toBe('"id", "tenantId", "status"')
    expect(identifiers(['id']).text).toBe('"id"')
    expect(() => identifiers(['id', 'x"y'])).toThrow('is not a plain column name')
    expect(() => identifiers([])).toThrow('join() needs at least one item')
  })
})
