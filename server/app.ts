/**
 * Portable API handler: `(Request) => Promise<Response>`.
 *
 * Runs unchanged on Cloudflare Pages Functions (functions/api/[[route]].ts),
 * and on any runtime with WHATWG fetch types (Node, Bun, Deno) given a
 * `SqlDatabase` adapter. See docs/CLOUD_ARCHITECTURE.md §1, §12, §13.
 */
import { z } from 'zod'
import { FORMAT_VERSION_V1 } from '../src/domain/export/v1'
import { sha256Hex } from '../src/domain/sync/canonical'
import { SYNC_LIMITS } from '../src/domain/sync/protocol'
import {
  ENROLLMENT_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  assertNotThrottled,
  assertSameOrigin,
  createSession,
  getIdKey,
  newEnrollmentCode,
  newToken,
  normalizeEnrollmentCode,
  readCookie,
  recordFailure,
  resolvePrincipal,
  sessionCookie,
  verifyAccessKey,
  type Principal,
} from './auth'
import type { SqlDatabase } from './db'
import { exportMeta, exportPage } from './exportData'
import { createRateLimiter, defaultSuggestionLimiter, suggestCategories, type AiBinding } from './ai/categorySuggest'
import { IDENTIFY_LIMITS, identifyRequestSchema } from '../src/analytics/products/identityProtocol'
import { IDENTIFY_RATE_LIMIT, searchFromEnv } from './products/config'
import { identitiesFor, identifyItems, listIdentities } from './products/identify'
import type { WebSearch } from './products/search'
import { SUGGEST_LIMITS, suggestRequestSchema } from '../src/analytics/categories/suggestProtocol'
import { ApiError, errorResponse, json, parseWith, readJson } from './http'
import { abortRun, applyBatch, completeRun, confirmRemovals, getRun, listRuns, startRun } from './sync'

export type AppEnv = {
  /** Hex SHA-256 of the owner access key (`npm run auth:generate-key`). */
  OWNER_ACCESS_KEY_SHA256?: string
  /** Cloudflare Workers AI binding (optional; only AI category suggestions use it). */
  AI?: AiBinding
  /** Web search API key for product identification (optional secret). */
  SEARCH_API_KEY?: string
}

export type AppDeps = {
  db: SqlDatabase
  env: AppEnv
  now?: () => Date
  /** Limits AI suggestion requests; defaults to one shared per isolate. */
  aiLimiter?: { check(now: Date): void }
  /** Limits product identification requests; defaults to one shared per isolate. */
  identifyLimiter?: { check(now: Date): void }
  /** Web search provider; defaults to the one configured by SEARCH_API_KEY (tests inject a fake). */
  search?: WebSearch | null
}

const defaultIdentifyLimiter = createRateLimiter(IDENTIFY_RATE_LIMIT)

const SMALL_BODY = 4 * 1024
export const SYNC_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Access = 'public' | 'owner' | 'device' | 'owner-or-device'
type Ctx = {
  request: Request
  url: URL
  params: string[]
  principal: Principal | null
  db: SqlDatabase
  env: AppEnv
  now: Date
  aiLimiter: { check(now: Date): void }
  identifyLimiter: { check(now: Date): void }
  search: WebSearch | null
}
type Route = { method: string; pattern: RegExp; access: Access; handle: (ctx: Ctx) => Promise<Response> }

const loginSchema = z.object({ accessKey: z.string().min(1).max(512) })
const enrollSchema = z.object({
  code: z.string().min(1).max(32),
  deviceName: z
    .string()
    .trim()
    .min(1, { error: 'deviceName is required.' })
    .max(60, { error: 'deviceName is at most 60 characters.' }),
})

const owner = (ctx: Ctx) => ctx.principal as { kind: 'owner' }
const device = (ctx: Ctx) => ctx.principal as { kind: 'device'; deviceId: string }

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    access: 'public',
    handle: async () => json({ ok: true, formatVersion: FORMAT_VERSION_V1 }),
  },

  // ── Owner auth ────────────────────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/auth\/login$/,
    access: 'public',
    handle: async ({ request, db, env, now }) => {
      assertSameOrigin(request)
      const { accessKey } = parseWith(loginSchema, await readJson(request, SMALL_BODY))
      await assertNotThrottled(db, 'login', now)
      if (!(await verifyAccessKey(accessKey, env.OWNER_ACCESS_KEY_SHA256))) {
        await recordFailure(db, 'login', now)
        throw new ApiError(401, 'invalid_credentials', 'The access key is not valid.')
      }
      const token = await createSession(db, now)
      return json({ authenticated: true }, 200, { 'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/logout$/,
    access: 'public',
    handle: async ({ request, db }) => {
      assertSameOrigin(request)
      const token = readCookie(request, SESSION_COOKIE)
      if (token) await db.run('DELETE FROM sessions WHERE token_sha256 = ?', [await sha256Hex(token)])
      return json({ authenticated: false }, 200, { 'set-cookie': sessionCookie('', 0) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/logout-everywhere$/,
    access: 'owner',
    handle: async ({ db }) => {
      await db.run('DELETE FROM sessions')
      return json({ authenticated: false }, 200, { 'set-cookie': sessionCookie('', 0) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/auth\/session$/,
    access: 'public',
    handle: async ({ principal }) => json({ authenticated: principal?.kind === 'owner' }),
  },

  // ── Devices (owner) ───────────────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/devices\/enrollment-codes$/,
    access: 'owner',
    handle: async ({ db, now }) => {
      const code = newEnrollmentCode()
      const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS).toISOString()
      await db.run('INSERT INTO enrollment_codes (code_sha256, created_at, expires_at) VALUES (?, ?, ?)', [
        await sha256Hex(normalizeEnrollmentCode(code)),
        now.toISOString(),
        expiresAt,
      ])
      return json({ code, expiresAt }, 201)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/devices$/,
    access: 'owner',
    handle: async ({ db }) =>
      json({
        devices: await db.all(
          'SELECT id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at DESC',
        ),
      }),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/devices\/([A-Za-z0-9_-]{1,64})$/,
    access: 'owner',
    handle: async ({ db, params, now }) => {
      const result = await db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
        now.toISOString(),
        params[0]!,
      ])
      if (result.changes === 0) throw new ApiError(404, 'device_not_found', 'No active device with that ID.')
      return json({ revoked: true })
    },
  },

  // ── Device API ────────────────────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/device\/enroll$/,
    access: 'public',
    handle: async ({ request, db, now }) => {
      const body = parseWith(enrollSchema, await readJson(request, SMALL_BODY))
      await assertNotThrottled(db, 'enroll', now)
      const codeHash = await sha256Hex(normalizeEnrollmentCode(body.code))
      const code = await db.first<{ expires_at: string }>(
        'SELECT expires_at FROM enrollment_codes WHERE code_sha256 = ? AND used_at IS NULL',
        [codeHash],
      )
      if (!code || code.expires_at <= now.toISOString()) {
        await recordFailure(db, 'enroll', now)
        throw new ApiError(401, 'invalid_code', 'The enrollment code is invalid, expired, or already used.')
      }
      const deviceId = `dev_${newToken().slice(0, 16)}`
      const deviceToken = newToken()
      const [, claim] = await db.batch([
        {
          sql: 'INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?, ?, ?, ?)',
          params: [deviceId, body.deviceName, await sha256Hex(deviceToken), now.toISOString()],
        },
        {
          sql: 'UPDATE enrollment_codes SET used_at = ?, device_id = ? WHERE code_sha256 = ? AND used_at IS NULL',
          params: [now.toISOString(), deviceId, codeHash],
        },
      ])
      if (claim!.changes !== 1) {
        // Lost a race with a concurrent enrollment using the same code.
        await db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', [now.toISOString(), deviceId])
        throw new ApiError(401, 'invalid_code', 'The enrollment code is invalid, expired, or already used.')
      }
      return json({ deviceId, deviceToken, idKey: await getIdKey(db) }, 201)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/device\/config$/,
    access: 'device',
    handle: async (ctx) =>
      json({
        deviceId: device(ctx).deviceId,
        idKey: await getIdKey(ctx.db),
        formatVersion: FORMAT_VERSION_V1,
        limits: SYNC_LIMITS,
      }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/device\/sync-requests$/,
    access: 'device',
    handle: async ({ db, now }) => {
      await expireSyncRequests(db, now)
      return json({
        requests: await db.all(
          "SELECT id, requested_at, status FROM sync_requests WHERE status IN ('pending', 'acknowledged') ORDER BY requested_at",
        ),
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/device\/sync-requests\/([A-Za-z0-9_-]{1,64})\/ack$/,
    access: 'device',
    handle: async (ctx) => {
      const result = await ctx.db.run(
        "UPDATE sync_requests SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by_device_id = ? WHERE id = ? AND status = 'pending'",
        [ctx.now.toISOString(), device(ctx).deviceId, ctx.params[0]!],
      )
      const row = await ctx.db.first('SELECT id, status FROM sync_requests WHERE id = ?', [ctx.params[0]!])
      if (!row) throw new ApiError(404, 'request_not_found', 'Sync request not found.')
      return json({ request: row, acknowledged: result.changes === 1 })
    },
  },

  // ── Sync requests (owner) ─────────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/sync-requests$/,
    access: 'owner',
    handle: async ({ db, now }) => {
      await expireSyncRequests(db, now)
      const open = await db.first(
        "SELECT id, requested_at, status FROM sync_requests WHERE status IN ('pending', 'acknowledged') ORDER BY requested_at LIMIT 1",
      )
      if (open) return json({ request: open, created: false })
      const id = `req_${newToken().slice(0, 16)}`
      await db.run("INSERT INTO sync_requests (id, requested_at, status) VALUES (?, ?, 'pending')", [
        id,
        now.toISOString(),
      ])
      return json({ request: { id, requested_at: now.toISOString(), status: 'pending' }, created: true }, 201)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/sync-requests$/,
    access: 'owner',
    handle: async ({ db, now }) => {
      await expireSyncRequests(db, now)
      return json({
        requests: await db.all('SELECT * FROM sync_requests ORDER BY requested_at DESC LIMIT 20'),
      })
    },
  },

  // ── Sync protocol ─────────────────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/sync\/runs$/,
    access: 'owner-or-device',
    handle: async (ctx) => {
      const result = await startRun(ctx.db, ctx.principal!, await readJson(ctx.request, SMALL_BODY), ctx.now)
      return json(result, result.created ? 201 : 200)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/sync\/runs$/,
    access: 'owner',
    handle: async ({ db, url }) => {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 100)
      return json(await listRuns(db, limit))
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/sync\/runs\/([0-9a-f-]{36})$/,
    access: 'owner-or-device',
    handle: async (ctx) => json(await getRun(ctx.db, ctx.principal!, ctx.params[0]!)),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/sync\/runs\/([0-9a-f-]{36})\/batches\/(\d{1,5})$/,
    access: 'owner-or-device',
    handle: async (ctx) =>
      json(
        await applyBatch(
          ctx.db,
          ctx.principal!,
          ctx.params[0]!,
          Number(ctx.params[1]),
          await readJson(ctx.request, SYNC_LIMITS.maxBatchBytes),
          ctx.now,
        ),
      ),
  },
  {
    method: 'POST',
    pattern: /^\/api\/sync\/runs\/([0-9a-f-]{36})\/complete$/,
    access: 'owner-or-device',
    handle: async (ctx) =>
      json(
        await completeRun(
          ctx.db,
          ctx.principal!,
          ctx.params[0]!,
          await readJson(ctx.request, SYNC_LIMITS.maxCompleteBytes),
          ctx.now,
        ),
      ),
  },
  {
    method: 'POST',
    pattern: /^\/api\/sync\/runs\/([0-9a-f-]{36})\/abort$/,
    access: 'owner-or-device',
    handle: async (ctx) => json(await abortRun(ctx.db, ctx.principal!, ctx.params[0]!, ctx.now)),
  },
  {
    method: 'POST',
    pattern: /^\/api\/sync\/runs\/([0-9a-f-]{36})\/confirm-removals$/,
    access: 'owner',
    handle: async (ctx) => json(await confirmRemovals(ctx.db, owner(ctx), ctx.params[0]!, ctx.now)),
  },

  // ── AI category suggestions (owner) ──────────────────────────────────────
  // Proposals only: nothing is stored, and nothing changes until the owner
  // accepts a suggestion in the dashboard (as a browser-side override).
  {
    method: 'POST',
    pattern: /^\/api\/categories\/suggest$/,
    access: 'owner',
    handle: async ({ request, env, now, aiLimiter, db }) => {
      const body = parseWith(suggestRequestSchema, await readJson(request, SUGGEST_LIMITS.maxRequestBytes))
      aiLimiter.check(now)
      // Give the model the public product identity already found by web search, if any.
      const identities = await identitiesFor(db, body.items.map((i) => i.itemNumber))
      return json(await suggestCategories(env.AI, body.items, identities))
    },
  },

  // ── Product identification (owner) ───────────────────────────────────────
  // Cache first; targeted web search only for unknown item numbers.
  {
    method: 'POST',
    pattern: /^\/api\/products\/identify$/,
    access: 'owner',
    handle: async ({ request, env, now, db, identifyLimiter, search }) => {
      const body = parseWith(identifyRequestSchema, await readJson(request, IDENTIFY_LIMITS.maxRequestBytes))
      identifyLimiter.check(now)
      return json(await identifyItems({ db, search, ai: env.AI, now }, body.items))
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/products\/identities$/,
    access: 'owner',
    handle: async ({ db }) => json({ identities: await listIdentities(db) }),
  },

  // ── Export (owner) ────────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: /^\/api\/export\/meta$/,
    access: 'owner',
    handle: async ({ db, now }) => json(await exportMeta(db, now)),
  },
  {
    method: 'GET',
    pattern: /^\/api\/export\/([A-Za-z]+)$/,
    access: 'owner',
    handle: async ({ db, params, url }) => json(await exportPage(db, params[0]!, url)),
  },
]

async function expireSyncRequests(db: SqlDatabase, now: Date): Promise<void> {
  await db.run(
    "UPDATE sync_requests SET status = 'expired' WHERE status IN ('pending', 'acknowledged') AND requested_at < ?",
    [new Date(now.getTime() - SYNC_REQUEST_TTL_MS).toISOString()],
  )
}

function authorize(route: Route, principal: Principal | null, request: Request): void {
  if (route.access === 'public') return
  if (!principal) throw new ApiError(401, 'unauthenticated', 'Authentication required.')
  const allowed =
    route.access === 'owner-or-device' ||
    (route.access === 'owner' && principal.kind === 'owner') ||
    (route.access === 'device' && principal.kind === 'device')
  if (!allowed) throw new ApiError(403, 'forbidden', 'This credential cannot use this endpoint.')
  // Cookie-authenticated state changes must be same-origin (CSRF defence).
  if (principal.kind === 'owner' && !['GET', 'HEAD'].includes(request.method)) assertSameOrigin(request)
}

export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    try {
      const candidates = routes.filter((r) => r.pattern.test(url.pathname))
      if (candidates.length === 0) throw new ApiError(404, 'not_found', 'Unknown API endpoint.')
      const route = candidates.find((r) => r.method === request.method)
      if (!route) throw new ApiError(405, 'method_not_allowed', 'Method not allowed.')
      const now = deps.now?.() ?? new Date()
      const principal = await resolvePrincipal(deps.db, request, now)
      authorize(route, principal, request)
      const params = route.pattern.exec(url.pathname)!.slice(1)
      return await route.handle({
        request,
        url,
        params,
        principal,
        db: deps.db,
        env: deps.env,
        now,
        aiLimiter: deps.aiLimiter ?? defaultSuggestionLimiter,
        identifyLimiter: deps.identifyLimiter ?? defaultIdentifyLimiter,
        search: deps.search !== undefined ? deps.search : searchFromEnv(deps.env),
      })
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error)
      // Never log request bodies or record values; the error class/message is enough.
      console.error('api_error', url.pathname, error instanceof Error ? error.name : 'unknown')
      return errorResponse(new ApiError(503, 'temporarily_unavailable', 'The server could not complete the request. It is safe to retry.'))
    }
  }
}
