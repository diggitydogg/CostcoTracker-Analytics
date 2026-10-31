/**
 * Canonical JSON and SHA-256 hashing, shared by the browser and the server.
 *
 * Canonical form: object keys sorted by UTF-16 code unit order, array order
 * preserved, no whitespace, `undefined` object members dropped. Two values that
 * are equal as data always produce the same text, so their hashes can be
 * compared to detect "unchanged" records during reconciliation.
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`)
}

const encoder = new TextEncoder()

/** Lower-case hex SHA-256 of a UTF-8 string (WebCrypto: browsers, Workers, Node ≥ 19). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value))
}
