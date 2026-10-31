// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { canonicalJson, hashCanonical, sha256Hex } from './canonical'

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}')
  })
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 'z' })).toBe(canonicalJson({ y: 'z', x: 1 }))
  })
  it('distinguishes array order and null from missing', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
  })
  it('drops undefined members like JSON.stringify', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
  })
  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow()
    expect(() => canonicalJson({ f: () => 1 })).toThrow()
  })
})

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 "abc" test vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('hashes equal data equally regardless of key order', async () => {
    expect(await hashCanonical({ a: 1, b: 2 })).toBe(await hashCanonical({ b: 2, a: 1 }))
  })
})
