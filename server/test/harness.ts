import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { applyMigrations, nodeSqliteDatabase, type NodeSqlite } from '../adapters/nodeSqlite'
import { createRateLimiter, type AiBinding } from '../ai/categorySuggest'
import { createApp } from '../app'
import type { WebSearch } from '../products/search'

export const ORIGIN = 'https://analytics.example.test'
export const ACCESS_KEY = 'test-access-key-0123456789abcdefghijklmnopqrstuvwxyz'
const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url))

export type Harness = {
  db: NodeSqlite
  clock: { now: Date }
  call(method: string, path: string, opts?: CallOptions): Promise<{ status: number; body: any; headers: Headers }>
  login(): Promise<string>
  enroll(name?: string): Promise<{ deviceId: string; deviceToken: string; idKey: string }>
}
type CallOptions = { body?: unknown; rawBody?: string; cookie?: string; bearer?: string; origin?: string | null }

export function createHarness(
  options: { configureKey?: boolean; ai?: AiBinding; aiLimiter?: { check(now: Date): void }; search?: WebSearch | null } = {},
): Harness {
  const db = nodeSqliteDatabase()
  applyMigrations(db, MIGRATIONS)
  const clock = { now: new Date('2026-10-31T12:00:00.000Z') }
  const app = createApp({
    db,
    env: {
      OWNER_ACCESS_KEY_SHA256:
        options.configureKey === false ? undefined : createHash('sha256').update(ACCESS_KEY).digest('hex'),
      ...(options.ai ? { AI: options.ai } : {}),
    },
    now: () => clock.now,
    // A fresh limiter per harness so tests never share the isolate-wide one.
    aiLimiter: options.aiLimiter ?? createRateLimiter(),
    identifyLimiter: createRateLimiter(),
    // Never reach a real search API from tests.
    search: options.search ?? null,
  })

  const call: Harness['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = {}
    if (opts.body !== undefined || opts.rawBody !== undefined) headers['content-type'] = 'application/json'
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN
    const res = await app(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      }),
    )
    return { status: res.status, body: await res.json(), headers: res.headers }
  }

  const login = async () => {
    const res = await call('POST', '/api/auth/login', { body: { accessKey: ACCESS_KEY } })
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
    return res.headers.get('set-cookie')!.split(';')[0]!
  }

  const enroll = async (name = 'Test iPhone') => {
    const cookie = await login()
    const code = await call('POST', '/api/devices/enrollment-codes', { cookie })
    const res = await call('POST', '/api/device/enroll', { body: { code: code.body.code, deviceName: name }, origin: null })
    if (res.status !== 201) throw new Error(`enroll failed: ${JSON.stringify(res.body)}`)
    return res.body
  }

  return { db, clock, call, login, enroll }
}

let counter = 0
/** Deterministic-looking v4 UUIDs for tests. */
export function uuid(): string {
  counter += 1
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`
}
