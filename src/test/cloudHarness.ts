/**
 * In-process cloud for UI tests: the real API handler (server/app.ts) over an
 * in-memory SQLite database with the real migration, plus a `fetch` that acts
 * like a same-origin browser (cookie jar, Origin header on writes).
 *
 * Faults can be injected per request to test network and server errors.
 */
import migration from '../../migrations/0001_initial.sql?raw'
import { applyMigrationSql, nodeSqliteDatabase, type NodeSqlite } from '../../server/adapters/nodeSqlite'
import { createRateLimiter, type AiBinding } from '../../server/ai/categorySuggest'
import { createApp } from '../../server/app'
import { createCloudApi, type CloudApi, type FetchLike } from '../cloud/api'
import type { AnalyticsExportV1 } from '../domain/export/v1'
import { importExportValue } from '../domain/import/importExport'
import { toSyncBatches } from '../domain/sync/protocol'
import { syntheticExport } from './fixtures'

export const ORIGIN = 'https://analytics.example.test'
export const ACCESS_KEY = 'ui-test-access-key-0123456789abcdefghijklmnop'

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Loosely typed JSON response, as a device client would see it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only JSON bodies
type DeviceBody = Record<string, any>

type Fault = {
  match: (method: string, path: string) => boolean
  respond: () => Response | Promise<never>
  times: number
}

export type CloudHarness = {
  db: NodeSqlite
  api: CloudApi
  fetch: FetchLike
  /** Every request the UI made, in order. */
  requests: { method: string; path: string }[]
  /** Fails the next `times` matching requests with a network error. */
  failNetwork(match: (method: string, path: string) => boolean, times?: number): void
  /** Answers the next `times` matching requests with this HTTP status (non-JSON body). */
  failStatus(match: (method: string, path: string) => boolean, status: number, times?: number): void
  /** Device-side helpers (what CostcoTracker iOS will do). */
  device: {
    enroll(code: string, name?: string): Promise<{ deviceId: string; deviceToken: string }>
    call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: DeviceBody }>
    sync(token: string, data: AnalyticsExportV1, mode?: 'incremental' | 'full', requestId?: string | null): Promise<DeviceBody>
  }
  /** Signs in directly (skipping the UI) so tests can start on a signed-in page. */
  signIn(): Promise<void>
  /** Ends every session server-side, as an expiry or "sign out everywhere" elsewhere would. */
  expireSessions(): void
  hasSessionCookie(): boolean
}

export async function createCloudHarness(options: { configured?: boolean; ai?: AiBinding } = {}): Promise<CloudHarness> {
  const db = nodeSqliteDatabase()
  applyMigrationSql(db, [migration])
  const app = createApp({
    db,
    env: {
      ...(options.configured === false ? {} : { OWNER_ACCESS_KEY_SHA256: await sha256Hex(ACCESS_KEY) }),
      ...(options.ai ? { AI: options.ai } : {}),
    },
    aiLimiter: createRateLimiter(),
  })
  let cookie: string | null = null
  const faults: Fault[] = []
  const requests: { method: string; path: string }[] = []

  const fetchLike: FetchLike = async (input, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = input
    requests.push({ method, path })
    const fault = faults.find((f) => f.times > 0 && f.match(method, path))
    if (fault) {
      fault.times -= 1
      return fault.respond()
    }
    const headers = new Headers(init.headers as HeadersInit | undefined)
    if (cookie) headers.set('cookie', cookie)
    // Browsers send Origin on same-origin non-GET requests.
    if (method !== 'GET' && method !== 'HEAD') headers.set('origin', ORIGIN)
    const response = await app(
      new Request(ORIGIN + path, { method, headers, body: (init.body as BodyInit | null | undefined) ?? null }),
    )
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) {
      const [pair] = setCookie.split(';')
      cookie = /Max-Age=0\b/.test(setCookie) ? null : pair!
    }
    return response
  }

  const deviceCall = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app(
      new Request(ORIGIN + path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    )
    return { status: res.status, body: (await res.json()) as DeviceBody }
  }

  let runCounter = 0
  const harness: CloudHarness = {
    db,
    api: createCloudApi(fetchLike),
    fetch: fetchLike,
    requests,
    failNetwork(match, times = 1) {
      faults.push({ match, times, respond: () => Promise.reject(new TypeError('Failed to fetch')) })
    },
    failStatus(match, status, times = 1) {
      faults.push({ match, times, respond: () => new Response('upstream error', { status }) })
    },
    device: {
      async enroll(code, name = 'Test iPhone') {
        const res = await app(
          new Request(ORIGIN + '/api/device/enroll', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code, deviceName: name }),
          }),
        )
        if (res.status !== 201) throw new Error(`enroll failed: ${res.status}`)
        return (await res.json()) as { deviceId: string; deviceToken: string }
      },
      call: deviceCall,
      async sync(token, data, mode = 'incremental', requestId = null) {
        runCounter += 1
        const runId = `00000000-0000-4000-8000-${runCounter.toString(16).padStart(12, '0')}`
        await deviceCall(token, 'POST', '/api/sync/runs', {
          runId,
          mode,
          formatVersion: 1,
          exportedAt: data.exportedAt,
          currency: data.currency,
          requestId,
        })
        const batches = toSyncBatches(data)
        for (const [seq, batch] of batches.entries()) {
          await deviceCall(token, 'PUT', `/api/sync/runs/${runId}/batches/${seq}`, batch)
        }
        const manifest =
          mode === 'full'
            ? {
                receiptIds: data.receipts.map((r) => r.id),
                returnIds: data.returns.map((r) => r.id),
                priceAdjustmentIds: data.priceAdjustments.map((r) => r.id),
              }
            : undefined
        return (await deviceCall(token, 'POST', `/api/sync/runs/${runId}/complete`, { batchCount: batches.length, manifest })).body
      },
    },
    async signIn() {
      await harness.api.login(ACCESS_KEY)
    },
    expireSessions() {
      db.raw.exec('DELETE FROM sessions')
    },
    hasSessionCookie: () => cookie !== null,
  }
  return harness
}

/** The synthetic fixture as validated V1 data, optionally modified. */
export function fixtureData(mutate?: (d: ReturnType<typeof syntheticExport>) => void): AnalyticsExportV1 {
  const raw = syntheticExport()
  mutate?.(raw)
  const result = importExportValue(raw)
  if (!result.ok) throw new Error('fixture invalid')
  return result.data
}

/** Enrolls a device through the API using a code minted for the owner. */
export async function enrollTestDevice(h: CloudHarness, name = 'Test iPhone') {
  const signedIn = h.hasSessionCookie()
  if (!signedIn) await h.signIn()
  const { code } = await h.api.createEnrollmentCode()
  return h.device.enroll(code, name)
}
