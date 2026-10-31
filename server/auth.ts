/**
 * Single-owner authentication (docs/CLOUD_ARCHITECTURE.md §4).
 *
 * - Owner: high-entropy access key → session cookie. Only SHA-256 digests of the
 *   key, session tokens, device tokens and enrollment codes are ever stored.
 * - Devices: one-time enrollment code → long-lived bearer token, revocable.
 */
import { sha256Hex } from '../src/domain/sync/canonical'
import type { SqlDatabase } from './db'
import { ApiError } from './http'

export const SESSION_COOKIE = '__Host-ctsession'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Sliding expiry is refreshed at most this often, to avoid a write per request. */
export const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000
export const THROTTLE = { windowMs: 15 * 60 * 1000, maxFailures: 10 } as const

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  return bytes
}

export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 256-bit random bearer secret. */
export function newToken(): string {
  return base64Url(randomBytes(32))
}

/** 10 Crockford base32 characters (50 bits), formatted XXXXX-XXXXX for display. */
export function newEnrollmentCode(): string {
  const bytes = randomBytes(10)
  const chars = [...bytes].map((b) => CROCKFORD[b & 31]).join('')
  return `${chars.slice(0, 5)}-${chars.slice(5)}`
}

/** Normalizes user-typed codes: case-insensitive, ignores spaces/dashes, Crockford aliases. */
export function normalizeEnrollmentCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/** Constant-time comparison of two strings of equal expected length (hex digests). */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

export type Principal = { kind: 'owner' } | { kind: 'device'; deviceId: string }

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`
}

export async function assertNotThrottled(db: SqlDatabase, kind: 'login' | 'enroll', now: Date): Promise<void> {
  const since = new Date(now.getTime() - THROTTLE.windowMs).toISOString()
  const row = await db.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM auth_failures WHERE kind = ? AND occurred_at > ?',
    [kind, since],
  )
  if ((row?.n ?? 0) >= THROTTLE.maxFailures) {
    throw new ApiError(429, 'too_many_attempts', 'Too many failed attempts. Try again in 15 minutes.')
  }
}

export async function recordFailure(db: SqlDatabase, kind: 'login' | 'enroll', now: Date): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  await db.batch([
    { sql: 'INSERT INTO auth_failures (kind, occurred_at) VALUES (?, ?)', params: [kind, now.toISOString()] },
    { sql: 'DELETE FROM auth_failures WHERE occurred_at < ?', params: [dayAgo] },
  ])
}

/** Verifies the owner access key against the configured SHA-256 digest. */
export async function verifyAccessKey(accessKey: string, configuredSha256: string | undefined): Promise<boolean> {
  if (!configuredSha256 || !/^[0-9a-f]{64}$/.test(configuredSha256)) {
    throw new ApiError(503, 'not_configured', 'The owner access key has not been configured on the server.')
  }
  return timingSafeEqual(await sha256Hex(accessKey), configuredSha256)
}

export async function createSession(db: SqlDatabase, now: Date): Promise<string> {
  const token = newToken()
  await db.run('INSERT INTO sessions (token_sha256, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?)', [
    await sha256Hex(token),
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    now.toISOString(),
  ])
  return token
}

export async function resolvePrincipal(db: SqlDatabase, request: Request, now: Date): Promise<Principal | null> {
  const authorization = request.headers.get('authorization')
  if (authorization) {
    // A bearer header is always a device credential; cookies are then ignored.
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(authorization)
    if (!match) return null
    const device = await db.first<{ id: string }>(
      'SELECT id FROM devices WHERE token_sha256 = ? AND revoked_at IS NULL',
      [await sha256Hex(match[1]!)],
    )
    return device ? { kind: 'device', deviceId: device.id } : null
  }

  const token = readCookie(request, SESSION_COOKIE)
  if (!token) return null
  const digest = await sha256Hex(token)
  const session = await db.first<{ expires_at: string; last_used_at: string }>(
    'SELECT expires_at, last_used_at FROM sessions WHERE token_sha256 = ?',
    [digest],
  )
  if (!session || session.expires_at <= now.toISOString()) return null
  if (now.getTime() - Date.parse(session.last_used_at) > SESSION_REFRESH_MS) {
    await db.run('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_sha256 = ?', [
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      digest,
    ])
  }
  return { kind: 'owner' }
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests: the Origin
 * header must match the request's own origin (in addition to SameSite=Strict).
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin')
  if (origin === null || origin !== new URL(request.url).origin) {
    throw new ApiError(403, 'cross_origin', 'Cross-origin requests are not allowed.')
  }
}

/** The per-instance key used to derive export IDs (§3). Created on first use. */
export async function getIdKey(db: SqlDatabase): Promise<string> {
  await db.run("INSERT INTO instance_settings (key, value) VALUES ('id_key', ?) ON CONFLICT(key) DO NOTHING", [
    base64Url(randomBytes(32)),
  ])
  const row = await db.first<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'id_key'")
  return row!.value
}
