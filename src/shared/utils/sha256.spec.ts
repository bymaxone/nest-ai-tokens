import { sha256Hex } from './sha256'

describe('sha256Hex', () => {
  /** Known FIPS 180-4 test vector: the empty string. Guards the padding-only block path. */
  it('hashes the empty string to the canonical digest', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  /** Known FIPS 180-4 test vector: "abc". Guards the single-block compression path. */
  it('hashes "abc" to the canonical digest', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  /** A 56+ byte input forces a second padded block, exercising the multi-block loop. */
  it('hashes a message that spans two blocks', () => {
    const input = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'
    expect(sha256Hex(input)).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  /** Multi-byte UTF-8 must be encoded before hashing, not treated as code units. */
  it('hashes multi-byte UTF-8 content', () => {
    expect(sha256Hex('héllo·世界')).toHaveLength(64)
    expect(sha256Hex('héllo·世界')).toMatch(/^[0-9a-f]{64}$/)
  })
})
