/**
 * Typed client for the owner-facing cloud API (same origin only).
 *
 * - Never sends anything to another origin: every path is a relative `/api/...`.
 * - Normalizes failures into `CloudApiError` with a stable `code`. Server error
 *   messages are written to never echo purchase data; the client adds none.
 */
import type { Item, PriceAdjustment, Receipt, Return } from '../domain/export/v1'
import type { SyncBatch } from '../domain/sync/protocol'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Field paths with messages (never values), when the server reports them. */
    readonly issues: { path: string; message: string }[] = [],
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'CloudApiError'
  }

  get isUnauthenticated(): boolean {
    return this.status === 401 && this.code === 'unauthenticated'
  }
  get isNetwork(): boolean {
    return this.code === 'network'
  }
}

export type Device = {
  id: string
  name: string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

export type SyncRequestStatus = 'pending' | 'acknowledged' | 'fulfilled' | 'expired'
export type SyncRequest = {
  id: string
  requested_at: string
  status: SyncRequestStatus
  acknowledged_at?: string | null
  acknowledged_by_device_id?: string | null
  fulfilled_run_id?: string | null
  fulfilled_at?: string | null
}

export type SyncRunStatus = 'open' | 'completed' | 'needs_review' | 'aborted' | 'abandoned'
export type SyncRun = {
  id: string
  device_id: string | null
  source: 'ios' | 'web-import'
  mode: 'incremental' | 'full'
  status: SyncRunStatus
  request_id: string | null
  started_at: string
  finished_at: string | null
  batch_count: number
  receipts_inserted: number
  receipts_updated: number
  receipts_revived: number
  receipts_unchanged: number
  items_written: number
  returns_inserted: number
  returns_updated: number
  returns_revived: number
  returns_unchanged: number
  adjustments_inserted: number
  adjustments_updated: number
  adjustments_revived: number
  adjustments_unchanged: number
  marked_missing: number
  error_code: string | null
  pendingRemovals: { receipts: number; returns: number; priceAdjustments: number } | null
}

export type ExportMeta = {
  format: string
  formatVersion: number
  exportedAt: string
  currency: string | null
  changeSeq: number
  counts: { receipts: number; items: number; returns: number; priceAdjustments: number; tombstoned: number }
}

export type ExportCollectionName = 'receipts' | 'items' | 'returns' | 'priceAdjustments'
type RecordFor = { receipts: Receipt; items: Item; returns: Return; priceAdjustments: PriceAdjustment }
export type ExportPage<C extends ExportCollectionName> = {
  collection: C
  records: { record: RecordFor[C]; changeSeq: number; missing: boolean }[]
  nextCursor: string | null
}

export type StartRunBody = {
  runId: string
  mode: 'incremental'
  formatVersion: 1
  exportedAt: string
  currency: string
}

export type BatchResult = {
  runId: string
  seq: number
  replayed: boolean
}

export type CloudApi = ReturnType<typeof createCloudApi>

export function createCloudApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
      })
    } catch {
      throw new CloudApiError(0, 'network', 'Could not reach your cloud. Check your connection and try again.')
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    if (response.ok) return parsed as T

    const error = (parsed as { error?: Record<string, unknown> } | null)?.error
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      const { code, message, issues, totalIssueCount: _total, ...details } = error
      void _total
      throw new CloudApiError(
        response.status,
        code,
        message,
        Array.isArray(issues) ? (issues as { path: string; message: string }[]) : [],
        details,
      )
    }
    throw new CloudApiError(
      response.status,
      response.status === 404 ? 'api_missing' : 'unexpected_response',
      response.status === 404
        ? 'The cloud API is not available at this address.'
        : `The cloud returned an unexpected response (HTTP ${response.status}).`,
    )
  }

  return {
    health: () => request<{ ok: boolean; formatVersion: number }>('GET', '/api/health'),
    session: () => request<{ authenticated: boolean }>('GET', '/api/auth/session'),
    login: (accessKey: string) => request<{ authenticated: true }>('POST', '/api/auth/login', { accessKey }),
    logout: () => request<{ authenticated: false }>('POST', '/api/auth/logout'),
    logoutEverywhere: () => request<{ authenticated: false }>('POST', '/api/auth/logout-everywhere'),

    devices: () => request<{ devices: Device[] }>('GET', '/api/devices'),
    createEnrollmentCode: () => request<{ code: string; expiresAt: string }>('POST', '/api/devices/enrollment-codes'),
    revokeDevice: (id: string) => request<{ revoked: true }>('DELETE', `/api/devices/${encodeURIComponent(id)}`),

    syncRequests: () => request<{ requests: SyncRequest[] }>('GET', '/api/sync-requests'),
    createSyncRequest: () => request<{ request: SyncRequest; created: boolean }>('POST', '/api/sync-requests'),

    runs: (limit = 20) => request<{ runs: SyncRun[] }>('GET', `/api/sync/runs?limit=${limit}`),
    startRun: (body: StartRunBody) => request<{ run: SyncRun; created: boolean }>('POST', '/api/sync/runs', body),
    putBatch: (runId: string, seq: number, batch: SyncBatch) =>
      request<BatchResult>('PUT', `/api/sync/runs/${runId}/batches/${seq}`, batch),
    completeRun: (runId: string, batchCount: number) =>
      request<{ run: SyncRun }>('POST', `/api/sync/runs/${runId}/complete`, { batchCount }),
    abortRun: (runId: string) => request<{ run: SyncRun }>('POST', `/api/sync/runs/${runId}/abort`),
    confirmRemovals: (runId: string) => request<{ run: SyncRun }>('POST', `/api/sync/runs/${runId}/confirm-removals`),

    exportMeta: () => request<ExportMeta>('GET', '/api/export/meta'),
    exportPage: <C extends ExportCollectionName>(collection: C, after: string | null, limit = 1000) => {
      const qs = new URLSearchParams({ limit: String(limit) })
      if (after !== null) qs.set('after', after)
      return request<ExportPage<C>>('GET', `/api/export/${collection}?${qs}`)
    },
  }
}
