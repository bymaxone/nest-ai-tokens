/**
 * @fileoverview A dependency-free, synchronous SHA-256 implementation. The
 * shared layer must run identically in Node, edge runtimes, and browsers, so it
 * cannot depend on `node:crypto` (absent on edge) or the async WebCrypto
 * `crypto.subtle` API. This is a direct transcription of FIPS 180-4 over 32-bit
 * word arithmetic; only `TextEncoder` (a Web-standard global) is used for UTF-8
 * encoding. Word buffers are held in `DataView`s so indexed reads return a
 * definite `number`. Internal — not exported from the public barrel.
 * @layer shared
 */

/** Round constants: first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K_WORDS: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

/** Initial hash values: first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const INITIAL_HASH: number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

/** Round constants held in a `DataView` so `kView.getUint32` returns a definite `number`. */
const kView = new DataView(new ArrayBuffer(64 * 4))
K_WORDS.forEach((value, index) => {
  kView.setUint32(index * 4, value)
})

/** Rotate a 32-bit word right by `n` bits. */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** Fill message-schedule words 16..63 from the first 16 (in place). */
function expandSchedule(w: DataView): void {
  for (let i = 16; i < 64; i++) {
    const w15 = w.getUint32((i - 15) * 4)
    const w2 = w.getUint32((i - 2) * 4)
    const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
    const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
    w.setUint32(i * 4, (w.getUint32((i - 16) * 4) + s0 + w.getUint32((i - 7) * 4) + s1) >>> 0)
  }
}

/** Run the 64 compression rounds for one block and fold the result into the hash state. */
function compressBlock(h: DataView, w: DataView): void {
  let a = h.getUint32(0)
  let b = h.getUint32(4)
  let c = h.getUint32(8)
  let d = h.getUint32(12)
  let e = h.getUint32(16)
  let f = h.getUint32(20)
  let g = h.getUint32(24)
  let hh = h.getUint32(28)

  for (let i = 0; i < 64; i++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
    const ch = (e & f) ^ (~e & g)
    const t1 = (hh + s1 + ch + kView.getUint32(i * 4) + w.getUint32(i * 4)) >>> 0
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
    const maj = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (s0 + maj) >>> 0
    hh = g
    g = f
    f = e
    e = (d + t1) >>> 0
    d = c
    c = b
    b = a
    a = (t1 + t2) >>> 0
  }

  const next = [a, b, c, d, e, f, g, hh]
  next.forEach((value, index) => {
    h.setUint32(index * 4, (h.getUint32(index * 4) + value) >>> 0)
  })
}

/**
 * Compute the SHA-256 digest of a UTF-8 string and return it as lowercase hex.
 *
 * @param input The string to hash.
 * @returns The 64-character hexadecimal digest.
 * @example
 * sha256Hex('abc') // 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
 */
export function sha256Hex(input: string): string {
  const message = new TextEncoder().encode(input)
  const bitLength = message.length * 8

  // Pad to a multiple of 64 bytes: append 0x80, zeros, then the 64-bit length.
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLength)
  bytes.set(message)
  bytes[message.length] = 0x80
  const view = new DataView(bytes.buffer)
  // Stryker disable next-line ArithmeticOperator: high 32-bit word of the bit length (SHA-256 Merkle-Damgård length padding); for messages shorter than 512 MB the high word is always 0, making * vs / indistinguishable in unit tests
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const hView = new DataView(new ArrayBuffer(32))
  INITIAL_HASH.forEach((value, index) => {
    hView.setUint32(index * 4, value)
  })
  const wView = new DataView(new ArrayBuffer(64 * 4))

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) wView.setUint32(i * 4, view.getUint32(offset + i * 4))
    expandSchedule(wView)
    compressBlock(hView, wView)
  }

  let hex = ''
  for (let i = 0; i < 8; i++) hex += hView.getUint32(i * 4).toString(16).padStart(8, '0')
  return hex
}
