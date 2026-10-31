// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AnalyticsExportV1 } from '../../src/domain/export/v1'
import { importExportValue } from '../../src/domain/import/importExport'
import { assembleExportV1 } from '../../src/domain/sync/exportAssembly'
import { toSyncBatches, type SyncBatch } from '../../src/domain/sync/protocol'
import { syntheticExport } from '../../src/test/fixtures'
import { ABANDON_AFTER_MS } from '../sync'
import { createHarness, uuid, type Harness } from './harness'

function fixtureData(mutate?: (d: ReturnType<typeof syntheticExport>) => void): AnalyticsExportV1 {
  const raw = syntheticExport()
  mutate?.(raw)
  const result = importExportValue(raw)
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.data
}

type Auth = { bearer?: string; cookie?: string; origin?: null }

async function start(h: Harness, auth: Auth, mode: 'incremental' | 'full' = 'incremental', extra: object = {}) {
  const runId = uuid()
  const res = await h.call('POST', '/api/sync/runs', {
    ...auth,
    body: { runId, mode, formatVersion: 1, exportedAt: '2026-10-31T18:00:00Z', currency: 'USD', ...extra },
  })
  return { runId, res }
}

/** Runs a complete sync of `data` and returns the completion response. */
async function syncAll(h: Harness, auth: Auth, data: AnalyticsExportV1, mode: 'incremental' | 'full' = 'incremental', extra: object = {}) {
  const { runId, res } = await start(h, auth, mode, extra)
  expect(res.status).toBe(201)
  const batches = toSyncBatches(data, 5)
  const results = []
  for (const [seq, batch] of batches.entries()) {
    const r = await h.call('PUT', `/api/sync/runs/${runId}/batches/${seq}`, { ...auth, body: batch })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    results.push(r.body)
  }
  const manifest =
    mode === 'full'
      ? {
          receiptIds: data.receipts.map((r) => r.id),
          returnIds: data.returns.map((r) => r.id),
          priceAdjustmentIds: data.priceAdjustments.map((r) => r.id),
        }
      : undefined
  const done = await h.call('POST', `/api/sync/runs/${runId}/complete`, {
    ...auth,
    body: { batchCount: batches.length, manifest },
  })
  return { runId, done, results, batches }
}

async function downloadAll(h: Harness, cookie: string, query = '') {
  const meta = (await h.call('GET', '/api/export/meta', { cookie })).body
  const collections: Record<string, unknown[]> = {}
  for (const c of ['receipts', 'items', 'returns', 'priceAdjustments']) {
    collections[c] = []
    let after: string | null = null
    do {
      const qs = new URLSearchParams(query)
      qs.set('limit', '2')
      if (after) qs.set('after', after)
      const page = await h.call('GET', `/api/export/${c}?${qs}`, { cookie })
      expect(page.status).toBe(200)
      collections[c]!.push(...page.body.records)
      after = page.body.nextCursor
    } while (after)
  }
  return { meta, collections }
}

const device = async (h: Harness) => ({ bearer: (await h.enroll()).deviceToken, origin: null }) as const
const count = (h: Harness, table: string) =>
  (h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const changeSeq = (h: Harness) =>
  (h.db.raw.prepare("SELECT value FROM sequences WHERE name = 'change_seq'").get() as { value: number }).value

describe('initial sync and export round trip', () => {
  it('stores every record and exports a file the importer accepts unchanged', async () => {
    const h = createHarness()
    const auth = await device(h)
    const data = fixtureData()
    const { done } = await syncAll(h, auth, data)
    expect(done.status).toBe(200)
    expect(done.body.run).toMatchObject({
      status: 'completed',
      source: 'ios',
      receipts_inserted: 4,
      items_written: 7,
      returns_inserted: 3,
      adjustments_inserted: 2,
    })

    const cookie = await h.login()
    const { meta, collections } = await downloadAll(h, cookie)
    expect(meta).toMatchObject({ currency: 'USD', counts: { receipts: 4, items: 7, returns: 3, priceAdjustments: 2 } })
    const unwrap = (rows: unknown[]) => (rows as { record: unknown }[]).map((r) => r.record)
    const { validation } = assembleExportV1(meta, {
      receipts: unwrap(collections.receipts!),
      items: unwrap(collections.items!),
      returns: unwrap(collections.returns!),
      priceAdjustments: unwrap(collections.priceAdjustments!),
    } as never)
    expect(validation.ok).toBe(true)
    if (!validation.ok) return
    const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))
    expect(byId(validation.data.receipts)).toEqual(byId(data.receipts))
    expect(byId(validation.data.items)).toEqual(byId(data.items))
    expect(byId(validation.data.returns)).toEqual(byId(data.returns))
    expect(byId(validation.data.priceAdjustments)).toEqual(byId(data.priceAdjustments))
  })

  it('never stores barcodes or credential-like fields', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    const batch = toSyncBatches(fixtureData(), 200)[0]!
    const poisoned = structuredClone(batch) as unknown as { receipts: Record<string, unknown>[] }
    poisoned.receipts[0]!.costcoSessionCookie = 'SECRET'
    const res = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: poisoned })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('forbidden_field')
    expect(res.body.error.issues[0].path).toBe('receipts[0].costcoSessionCookie')
    expect(JSON.stringify(res.body)).not.toContain('SECRET')
    expect(count(h, 'receipts')).toBe(0)
  })
})

describe('idempotency', () => {
  it('replays an identical batch without applying it twice', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    const batch = toSyncBatches(fixtureData(), 200)[0]!
    const first = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: batch })
    const seqAfterFirst = changeSeq(h)
    const second = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: batch })
    expect(second.status).toBe(200)
    expect(second.body.replayed).toBe(true)
    expect(second.body.counts).toEqual(first.body.counts)
    expect(changeSeq(h)).toBe(seqAfterFirst)
    const run = await h.call('GET', `/api/sync/runs/${runId}`, auth)
    expect(run.body.run.receipts_inserted).toBe(4)
    expect(run.body.receivedSeqs).toEqual([0])
  })

  it('treats a key-reordered replay as identical (canonical payload hash)', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    const batch = toSyncBatches(fixtureData(), 200)[0]!
    await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: batch })
    const reordered = { priceAdjustments: batch.priceAdjustments, returns: batch.returns, receipts: batch.receipts }
    expect((await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: reordered })).body.replayed).toBe(true)
  })

  it('rejects different content under an already-used sequence number', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    const [a, b] = toSyncBatches(fixtureData(), 5)
    await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: a })
    const res = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: b })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('batch_conflict')
  })

  it('returns the existing run when the same runId is started again', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    const again = await h.call('POST', '/api/sync/runs', {
      ...auth,
      body: { runId, mode: 'incremental', formatVersion: 1, exportedAt: '2026-10-31T18:00:00Z', currency: 'USD' },
    })
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect(count(h, 'sync_runs')).toBe(1)
  })

  it('completing twice is harmless', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId, batches } = await syncAll(h, auth, fixtureData())
    const again = await h.call('POST', `/api/sync/runs/${runId}/complete`, { ...auth, body: { batchCount: batches.length } })
    expect(again.status).toBe(200)
    expect(again.body.run.status).toBe('completed')
  })

  it('reports exactly which batches are missing so a client can resume', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    const batches = toSyncBatches(fixtureData(), 5)
    await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: batches[0] })
    await h.call('PUT', `/api/sync/runs/${runId}/batches/2`, { ...auth, body: batches[2] })
    const res = await h.call('POST', `/api/sync/runs/${runId}/complete`, { ...auth, body: { batchCount: batches.length } })
    expect(res.status).toBe(409)
    expect(res.body.error.missingSeqs).toEqual([1, ...Array.from({ length: batches.length - 3 }, (_, i) => i + 3)])
  })
})

describe('reconciliation', () => {
  it('re-syncing unchanged data writes nothing but the batch log', async () => {
    const h = createHarness()
    const auth = await device(h)
    await syncAll(h, auth, fixtureData())
    const before = h.db.raw.prepare('SELECT id, change_seq, updated_at FROM receipts ORDER BY id').all()
    h.clock.now = new Date(h.clock.now.getTime() + 60_000)
    const { done } = await syncAll(h, auth, fixtureData())
    expect(done.body.run).toMatchObject({
      receipts_inserted: 0,
      receipts_updated: 0,
      receipts_unchanged: 4,
      items_written: 0,
      returns_unchanged: 3,
      adjustments_unchanged: 2,
    })
    expect(h.db.raw.prepare('SELECT id, change_seq, updated_at FROM receipts ORDER BY id').all()).toEqual(before)
  })

  it('replaces a changed receipt bundle and its items, leaving other receipts alone', async () => {
    const h = createHarness()
    const auth = await device(h)
    await syncAll(h, auth, fixtureData())
    const changed = fixtureData((d) => {
      // Receipt 1 is re-synced: one item price changes and item i_2 disappears.
      d.items[0]!.lineTotalCents = 2099
      d.items[0]!.unitPriceCents = 2099
      d.items.splice(1, 1)
    })
    const { done } = await syncAll(h, auth, changed)
    expect(done.body.run).toMatchObject({ receipts_updated: 1, receipts_unchanged: 3, items_written: 1 })
    expect(h.db.raw.prepare("SELECT id FROM items WHERE receipt_id = 'r_synthetic0001'").all()).toEqual([{ id: 'i_1' }])
    expect(count(h, 'items')).toBe(6)
  })

  it('updates a changed return in place', async () => {
    const h = createHarness()
    const auth = await device(h)
    await syncAll(h, auth, fixtureData())
    const { done } = await syncAll(h, auth, fixtureData((d) => (d.returns[2]!.merchandiseAmountCents = 75)))
    expect(done.body.run).toMatchObject({ returns_updated: 1, returns_unchanged: 2 })
    expect(h.db.raw.prepare("SELECT merchandise_amount_cents AS m FROM item_returns WHERE id = 'ret_3'").get()).toEqual({ m: 75 })
  })

  it('incremental syncs never tombstone records they did not send', async () => {
    const h = createHarness()
    const auth = await device(h)
    await syncAll(h, auth, fixtureData())
    await syncAll(h, auth, fixtureData((d) => {
      d.receipts = d.receipts.slice(0, 1)
      d.items = d.items.filter((i) => i.purchaseId === 'r_synthetic0001')
      d.returns = []
      d.priceAdjustments = []
    }))
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM receipts WHERE missing_since_run_id IS NOT NULL').get()).toEqual({ n: 0 })
  })

  it('a full sync tombstones (never deletes) a record the source no longer has, and a later sync revives it', async () => {
    const h = createHarness()
    const auth = await device(h)
    // Seed enough rows that removing one stays below the mass-removal guard.
    const many = fixtureData((d) => {
      for (let i = 0; i < 10; i++) {
        d.receipts.push({ id: `r_extra${i}`, sourceType: 'synthetic', identifierKind: 'synthetic', purchaseDate: '2026-03-01', warehouse: null })
      }
    })
    await syncAll(h, auth, many, 'full')
    const without = { ...many, receipts: many.receipts.filter((r) => r.id !== 'r_extra0') }
    const { runId, done } = await syncAll(h, auth, without, 'full')
    expect(done.body.run).toMatchObject({ status: 'completed', marked_missing: 1 })
    expect(h.db.raw.prepare("SELECT missing_since_run_id AS m FROM receipts WHERE id = 'r_extra0'").get()).toEqual({ m: runId })
    expect(count(h, 'receipts')).toBe(14)

    const cookie = await h.login()
    const meta = await h.call('GET', '/api/export/meta', { cookie })
    expect(meta.body.counts).toMatchObject({ receipts: 13, tombstoned: 1 })

    const { done: revived } = await syncAll(h, auth, many, 'incremental')
    expect(revived.body.run).toMatchObject({ receipts_revived: 1 })
    expect(h.db.raw.prepare("SELECT missing_since_run_id AS m FROM receipts WHERE id = 'r_extra0'").get()).toEqual({ m: null })
  })

  it('holds back a mass removal for review, then applies it only when the owner confirms', async () => {
    const h = createHarness()
    const auth = await device(h)
    await syncAll(h, auth, fixtureData(), 'full')
    // A wiped phone database: the full sync contains only one receipt.
    const wiped = fixtureData((d) => {
      d.receipts = d.receipts.slice(0, 1)
      d.items = d.items.filter((i) => i.purchaseId === 'r_synthetic0001')
      d.returns = []
      d.priceAdjustments = []
    })
    const { runId, done } = await syncAll(h, auth, wiped, 'full')
    expect(done.body.run).toMatchObject({
      status: 'needs_review',
      marked_missing: 0,
      pendingRemovals: { receipts: 3, returns: 3, priceAdjustments: 2 },
    })
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM receipts WHERE missing_since_run_id IS NOT NULL').get()).toEqual({ n: 0 })

    // Devices cannot confirm; only the owner can.
    expect((await h.call('POST', `/api/sync/runs/${runId}/confirm-removals`, auth)).status).toBe(403)
    const cookie = await h.login()
    const confirmed = await h.call('POST', `/api/sync/runs/${runId}/confirm-removals`, { cookie })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.run).toMatchObject({ status: 'completed', marked_missing: 8, pendingRemovals: null })
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM receipts WHERE missing_since_run_id IS NOT NULL').get()).toEqual({ n: 3 })
  })

  it('rejects a full-sync manifest that does not match what was sent', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth, 'full')
    const batch = toSyncBatches(fixtureData(), 200)[0]!
    await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: batch })
    const res = await h.call('POST', `/api/sync/runs/${runId}/complete`, {
      ...auth,
      body: { batchCount: 1, manifest: { receiptIds: ['r_synthetic0001'], returnIds: [], priceAdjustmentIds: [] } },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('manifest_mismatch')
  })

  it('requires a manifest for full syncs and forbids one for incremental syncs', async () => {
    const h = createHarness()
    const auth = await device(h)
    const full = await start(h, auth, 'full')
    expect((await h.call('POST', `/api/sync/runs/${full.runId}/complete`, { ...auth, body: { batchCount: 0 } })).body.error.code).toBe('manifest_required')
    const inc = await start(h, auth)
    const res = await h.call('POST', `/api/sync/runs/${inc.runId}/complete`, {
      ...auth,
      body: { batchCount: 0, manifest: { receiptIds: [], returnIds: [], priceAdjustmentIds: [] } },
    })
    expect(res.body.error.code).toBe('manifest_not_allowed')
  })
})

describe('reference and transaction checks', () => {
  it('rejects a sourcePurchaseId that does not resolve, and accepts one stored by an earlier batch', async () => {
    const h = createHarness()
    const auth = await device(h)
    const data = fixtureData()
    await syncAll(h, auth, data)
    const linked = { receipts: [], returns: [{ ...data.returns[2]!, sourcePurchaseId: 'r_synthetic0002' }], priceAdjustments: [] }
    const { runId } = await start(h, auth)
    expect((await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: linked })).status).toBe(200)
    const bad = { receipts: [], returns: [{ ...data.returns[2]!, sourcePurchaseId: 'r_nowhere' }], priceAdjustments: [] }
    const res = await h.call('PUT', `/api/sync/runs/${runId}/batches/1`, { ...auth, body: bad })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('unknown_purchase')
  })

  it('rejects a batch whose transaction disagrees with rows stored earlier', async () => {
    const h = createHarness()
    const auth = await device(h)
    const data = fixtureData()
    await syncAll(h, auth, data)
    // Only one row of transaction t_synthetic0001, with a different total.
    const partial = { receipts: [], returns: [{ ...data.returns[0]!, transactionTotalCents: -1 }], priceAdjustments: [] }
    const { runId } = await start(h, auth)
    const res = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: partial })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('transaction_conflict')
    // Sending the whole transaction with the new total is fine.
    const whole = {
      receipts: [],
      returns: data.returns.slice(0, 2).map((r) => ({ ...r, transactionTotalCents: -1 })),
      priceAdjustments: [],
    }
    expect((await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: whole })).status).toBe(200)
  })

  it('rejects a transactionId that equals a stored receipt ID', async () => {
    const h = createHarness()
    const auth = await device(h)
    const data = fixtureData()
    await syncAll(h, auth, data)
    const { runId } = await start(h, auth)
    const body = { receipts: [], returns: [{ ...data.returns[2]!, transactionId: 'r_synthetic0001' }], priceAdjustments: [] }
    const res = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body })
    expect(res.body.error.code).toBe('id_namespace_conflict')
  })

  it('rejects an invalid batch with field paths and stores nothing', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    const batch = toSyncBatches(fixtureData(), 200)[0]! as SyncBatch
    const bad = structuredClone(batch) as unknown as { receipts: { items: Record<string, unknown>[] }[] }
    bad.receipts[0]!.items[0]!.lineTotalCents = 21.99
    const res = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: bad })
    expect(res.status).toBe(400)
    expect(res.body.error.issues[0].path).toBe('receipts[0].items[0].lineTotalCents')
    expect(count(h, 'receipts')).toBe(0)
    expect(count(h, 'sync_batches')).toBe(0)
  })

  it('rejects oversized batches with 413', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    const receipts = Array.from({ length: 201 }, (_, i) => ({
      id: `r_big${i}`, sourceType: 'synthetic', identifierKind: 'synthetic', purchaseDate: null, warehouse: null, items: [],
    }))
    const res = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: { receipts, returns: [], priceAdjustments: [] } })
    expect(res.status).toBe(413)
    const huge = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, rawBody: ' '.repeat(300 * 1024) })
    expect(huge.status).toBe(413)
  })
})

describe('run lifecycle and access', () => {
  it('lets the website import JSON (incremental only)', async () => {
    const h = createHarness()
    const cookie = await h.login()
    const { done } = await syncAll(h, { cookie }, fixtureData())
    expect(done.body.run).toMatchObject({ source: 'web-import', device_id: null, status: 'completed' })
    const full = await start(h, { cookie }, 'full')
    expect(full.res.status).toBe(400)
    expect(full.res.body.error.code).toBe('mode_not_allowed')
  })

  it('hides one device\'s runs from another device', async () => {
    const h = createHarness()
    const a = await device(h)
    const b = await device(h)
    const { runId } = await start(h, a)
    expect((await h.call('GET', `/api/sync/runs/${runId}`, b)).status).toBe(404)
    expect((await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...b, body: { receipts: [], returns: [], priceAdjustments: [] } })).status).toBe(404)
  })

  it('marks stale open runs abandoned and refuses new batches for them', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    h.clock.now = new Date(h.clock.now.getTime() + ABANDON_AFTER_MS + 1000)
    await start(h, auth)
    const run = await h.call('GET', `/api/sync/runs/${runId}`, auth)
    expect(run.body.run.status).toBe('abandoned')
    const res = await h.call('PUT', `/api/sync/runs/${runId}/batches/0`, { ...auth, body: { receipts: [], returns: [], priceAdjustments: [] } })
    expect(res.body.error.code).toBe('run_not_open')
  })

  it('aborts a run', async () => {
    const h = createHarness()
    const auth = await device(h)
    const { runId } = await start(h, auth)
    expect((await h.call('POST', `/api/sync/runs/${runId}/abort`, auth)).body.run.status).toBe('aborted')
  })

  it('rejects a currency different from the instance currency', async () => {
    const h = createHarness()
    const auth = await device(h)
    await start(h, auth)
    const { res } = await start(h, auth, 'incremental', { currency: 'CAD' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('currency_mismatch')
  })

  it('lists sync history for the owner, newest first', async () => {
    const h = createHarness()
    const auth = await device(h)
    const first = await syncAll(h, auth, fixtureData())
    h.clock.now = new Date(h.clock.now.getTime() + 1000)
    const second = await syncAll(h, auth, fixtureData())
    const cookie = await h.login()
    const res = await h.call('GET', '/api/sync/runs?limit=10', { cookie })
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual([second.runId, first.runId])
  })
})

describe('website-triggered sync requests', () => {
  it('flows from request → acknowledged → fulfilled by a run', async () => {
    const h = createHarness()
    const auth = await device(h)
    const cookie = await h.login()
    const created = await h.call('POST', '/api/sync-requests', { cookie })
    expect(created.status).toBe(201)
    const again = await h.call('POST', '/api/sync-requests', { cookie })
    expect(again.body).toMatchObject({ created: false, request: { id: created.body.request.id } })

    const pending = await h.call('GET', '/api/device/sync-requests', auth)
    expect(pending.body.requests).toHaveLength(1)
    const requestId = pending.body.requests[0].id
    const ack = await h.call('POST', `/api/device/sync-requests/${requestId}/ack`, auth)
    expect(ack.body).toMatchObject({ acknowledged: true, request: { status: 'acknowledged' } })

    await syncAll(h, auth, fixtureData(), 'incremental', { requestId })
    const list = await h.call('GET', '/api/sync-requests', { cookie })
    expect(list.body.requests[0]).toMatchObject({ id: requestId, status: 'fulfilled' })
    expect((await h.call('GET', '/api/device/sync-requests', auth)).body.requests).toEqual([])
  })

  it('expires unanswered requests after 7 days', async () => {
    const h = createHarness()
    const auth = await device(h)
    const cookie = await h.login()
    await h.call('POST', '/api/sync-requests', { cookie })
    h.clock.now = new Date(h.clock.now.getTime() + 8 * 24 * 60 * 60 * 1000)
    expect((await h.call('GET', '/api/device/sync-requests', auth)).body.requests).toEqual([])
  })
})

describe('export', () => {
  it('pages with a cursor and supports delta fetches by change sequence', async () => {
    const h = createHarness()
    const auth = await device(h)
    await syncAll(h, auth, fixtureData())
    const cookie = await h.login()
    const { meta } = await downloadAll(h, cookie)
    const high = meta.changeSeq

    await syncAll(h, auth, fixtureData((d) => (d.returns[2]!.merchandiseAmountCents = 75)))
    const delta = await downloadAll(h, cookie, `sinceSeq=${high}`)
    expect(delta.collections.receipts).toEqual([])
    expect(delta.collections.returns!.map((r: any) => r.record.id)).toEqual(['ret_3'])
    expect((delta.collections.returns![0] as any).changeSeq).toBeGreaterThan(high)
  })

  it('excludes tombstoned rows by default and includes them on request', async () => {
    const h = createHarness()
    const auth = await device(h)
    const data = fixtureData((d) => {
      for (let i = 0; i < 10; i++) d.receipts.push({ id: `r_x${i}`, sourceType: 'synthetic', identifierKind: 'synthetic', purchaseDate: null, warehouse: null })
    })
    await syncAll(h, auth, data, 'full')
    await syncAll(h, auth, { ...data, receipts: data.receipts.filter((r) => r.id !== 'r_x0') }, 'full')
    const cookie = await h.login()
    const live = await h.call('GET', '/api/export/receipts?limit=1000', { cookie })
    expect(live.body.records.map((r: any) => r.record.id)).not.toContain('r_x0')
    const all = await h.call('GET', '/api/export/receipts?limit=1000&includeMissing=1', { cookie })
    expect(all.body.records.find((r: any) => r.record.id === 'r_x0')).toMatchObject({ missing: true })
  })

  it('validates paging parameters', async () => {
    const h = createHarness()
    const cookie = await h.login()
    expect((await h.call('GET', '/api/export/receipts?limit=5000', { cookie })).status).toBe(400)
    expect((await h.call('GET', '/api/export/receipts?sinceSeq=-1', { cookie })).status).toBe(400)
    expect((await h.call('GET', '/api/export/barcodes', { cookie })).status).toBe(404)
  })
})
