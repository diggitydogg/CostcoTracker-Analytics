/**
 * Sync service (docs/CLOUD_ARCHITECTURE.md §5–§6).
 *
 * Every batch is applied in a single transaction together with its
 * `sync_batches` row, so a batch is applied exactly once: a replay with the
 * same payload returns the stored result, a different payload under the same
 * sequence number is rejected.
 */
import { hashCanonical } from '../src/domain/sync/canonical'
import {
  completeRunSchema,
  startRunSchema,
  validateSyncBatch,
  type SyncBatch,
} from '../src/domain/sync/protocol'
import {
  countPlan,
  hashBatch,
  planBatch,
  planMissing,
  type BatchCounts,
  type RecordKind,
  type StoredState,
} from '../src/domain/sync/reconcile'
import type { Principal } from './auth'
import { ConstraintError, sql, type SqlDatabase, type Statement } from './db'
import { ApiError, parseWith } from './http'

export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000

const NEXT_SEQ: Statement = sql("UPDATE sequences SET value = value + 1 WHERE name = 'change_seq'")
const CURRENT_SEQ = "(SELECT value FROM sequences WHERE name = 'change_seq')"

type RunRow = {
  id: string
  device_id: string | null
  source: 'ios' | 'web-import'
  mode: 'incremental' | 'full'
  status: 'open' | 'completed' | 'needs_review' | 'aborted' | 'abandoned'
  request_id: string | null
  started_at: string
  finished_at: string | null
  batch_count: number
  pending_removals_json: string | null
  [counter: string]: unknown
}

const TABLE: Record<RecordKind, string> = {
  receipts: 'receipts',
  returns: 'item_returns',
  priceAdjustments: 'price_adjustments',
}
const HASH_COLUMN: Record<RecordKind, string> = {
  receipts: 'bundle_hash',
  returns: 'content_hash',
  priceAdjustments: 'content_hash',
}

function canAccessRun(principal: Principal, run: RunRow): boolean {
  return principal.kind === 'owner' || (principal.kind === 'device' && run.device_id === principal.deviceId)
}

async function loadRun(db: SqlDatabase, principal: Principal, runId: string): Promise<RunRow> {
  const run = await db.first<RunRow>('SELECT * FROM sync_runs WHERE id = ?', [runId])
  if (!run || !canAccessRun(principal, run)) throw new ApiError(404, 'run_not_found', 'Sync run not found.')
  return run
}

export function publicRun(run: RunRow) {
  const { pending_removals_json, ...rest } = run
  const pending = pending_removals_json ? (JSON.parse(pending_removals_json) as Record<RecordKind, string[]>) : null
  return {
    ...rest,
    pendingRemovals: pending
      ? {
          receipts: pending.receipts.length,
          returns: pending.returns.length,
          priceAdjustments: pending.priceAdjustments.length,
        }
      : null,
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

export async function startRun(db: SqlDatabase, principal: Principal, body: unknown, now: Date) {
  const req = parseWith(startRunSchema, body)
  const source = principal.kind === 'device' ? 'ios' : 'web-import'
  if (source === 'web-import' && req.mode !== 'incremental') {
    throw new ApiError(400, 'mode_not_allowed', 'Imports from the website may only use incremental mode.')
  }

  const existing = await db.first<RunRow>('SELECT * FROM sync_runs WHERE id = ?', [req.runId])
  if (existing) {
    if (!canAccessRun(principal, existing) || existing.mode !== req.mode) {
      throw new ApiError(409, 'run_id_conflict', 'This runId is already used by a different run.')
    }
    return { run: publicRun(existing), created: false }
  }

  await db.run(
    "INSERT INTO instance_settings (key, value) VALUES ('currency', ?) ON CONFLICT(key) DO NOTHING",
    [req.currency],
  )
  const currency = await db.first<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'currency'")
  if (currency?.value !== req.currency) {
    throw new ApiError(400, 'currency_mismatch', `This instance stores ${currency?.value} data; got ${req.currency}.`)
  }

  if (req.requestId !== null) {
    const request = await db.first('SELECT id FROM sync_requests WHERE id = ?', [req.requestId])
    if (!request) throw new ApiError(400, 'unknown_request', 'requestId does not name a sync request.')
  }

  const iso = now.toISOString()
  const statements: Statement[] = [
    sql(
      "UPDATE sync_runs SET status = 'abandoned', finished_at = ? WHERE status = 'open' AND started_at < ?",
      iso,
      new Date(now.getTime() - ABANDON_AFTER_MS).toISOString(),
    ),
    sql(
      `INSERT INTO sync_runs (id, device_id, source, mode, status, format_version, exported_at, request_id, started_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      req.runId,
      principal.kind === 'device' ? principal.deviceId : null,
      source,
      req.mode,
      req.formatVersion,
      req.exportedAt,
      req.requestId,
      iso,
    ),
  ]
  if (principal.kind === 'device') {
    statements.push(sql('UPDATE devices SET last_seen_at = ? WHERE id = ?', iso, principal.deviceId))
  }
  await db.batch(statements)
  const run = await loadRun(db, principal, req.runId)
  return { run: publicRun(run), created: true }
}

// ── Batches ─────────────────────────────────────────────────────────────────

const ids = (values: Iterable<string>) => JSON.stringify([...values])

async function storedStates(db: SqlDatabase, kind: RecordKind, idList: string[]): Promise<Map<string, StoredState>> {
  if (idList.length === 0) return new Map()
  const rows = await db.all<{ id: string; hash: string; missing: string | null }>(
    `SELECT id, ${HASH_COLUMN[kind]} AS hash, missing_since_run_id AS missing
     FROM ${TABLE[kind]} WHERE id IN (SELECT value FROM json_each(?))`,
    [ids(idList)],
  )
  return new Map(rows.map((r) => [r.id, { hash: r.hash, missing: r.missing !== null }]))
}

type TransactionFields = { date: string | null; warehouse: string | null; type: string | null; total: number | null }

/** Cross-batch checks that need the database. */
async function checkReferences(db: SqlDatabase, batch: SyncBatch): Promise<void> {
  const batchReceiptIds = new Set(batch.receipts.map((r) => r.id))
  const txnRows = [...batch.returns, ...batch.priceAdjustments]

  // sourcePurchaseId must resolve to a receipt in this batch or already stored.
  const external = new Set(
    txnRows.map((r) => r.sourcePurchaseId).filter((id): id is string => id !== null && !batchReceiptIds.has(id)),
  )
  if (external.size > 0) {
    const found = await db.all<{ id: string }>(
      'SELECT id FROM receipts WHERE id IN (SELECT value FROM json_each(?))',
      [ids(external)],
    )
    const foundIds = new Set(found.map((r) => r.id))
    const missing = [...external].filter((id) => !foundIds.has(id))
    if (missing.length > 0) {
      throw new ApiError(409, 'unknown_purchase', 'sourcePurchaseId references a receipt that is not stored.', [
        { path: '(batch)', message: `${missing.length} sourcePurchaseId value(s) do not resolve.` },
      ])
    }
  }

  // Transaction IDs and receipt IDs are separate namespaces (no implicit joins).
  const txnIds = new Set(txnRows.map((r) => r.transactionId))
  if (txnIds.size > 0 || batchReceiptIds.size > 0) {
    const clash = await db.first<{ n: number }>(
      `SELECT
         (SELECT COUNT(*) FROM receipts WHERE id IN (SELECT value FROM json_each(?))) +
         (SELECT COUNT(*) FROM item_returns WHERE transaction_id IN (SELECT value FROM json_each(?))) +
         (SELECT COUNT(*) FROM price_adjustments WHERE transaction_id IN (SELECT value FROM json_each(?))) AS n`,
      [ids(txnIds), ids(batchReceiptIds), ids(batchReceiptIds)],
    )
    if ((clash?.n ?? 0) > 0) {
      throw new ApiError(409, 'id_namespace_conflict', 'A transactionId equals a receipt ID.')
    }
  }

  // Rows already stored for these transactions (but not in this batch) must
  // agree on transaction-level fields, so per-transaction totals stay unambiguous.
  if (txnIds.size === 0) return
  const incoming = new Map<string, TransactionFields>()
  for (const r of batch.returns) {
    incoming.set(r.transactionId, { date: r.returnDate, warehouse: r.warehouse, type: r.transactionType, total: r.transactionTotalCents })
  }
  for (const a of batch.priceAdjustments) {
    incoming.set(a.transactionId, { date: a.adjustmentDate, warehouse: a.warehouse, type: a.transactionType, total: a.transactionTotalCents })
  }
  const batchRowIds = new Set(txnRows.map((r) => r.id))
  const stored = await db.all<{ id: string; transaction_id: string } & { date: string | null; warehouse: string | null; type: string | null; total: number | null }>(
    `SELECT id, transaction_id, return_date AS date, warehouse, transaction_type AS type, transaction_total_cents AS total
       FROM item_returns WHERE transaction_id IN (SELECT value FROM json_each(?))
     UNION ALL
     SELECT id, transaction_id, adjustment_date AS date, warehouse, transaction_type AS type, transaction_total_cents AS total
       FROM price_adjustments WHERE transaction_id IN (SELECT value FROM json_each(?))`,
    [ids(txnIds), ids(txnIds)],
  )
  for (const row of stored) {
    if (batchRowIds.has(row.id)) continue
    const want = incoming.get(row.transaction_id)!
    if (row.date !== want.date || row.warehouse !== want.warehouse || row.type !== want.type || row.total !== want.total) {
      throw new ApiError(
        409,
        'transaction_conflict',
        'Stored rows of a transaction in this batch disagree with it. Send every row of a transaction together.',
      )
    }
  }
}

function receiptRows(batch: SyncBatch, wanted: Set<string>, hashes: Map<string, string>) {
  return batch.receipts
    .filter((r) => wanted.has(r.id))
    .map((r) => ({
      id: r.id,
      sourceType: r.sourceType,
      identifierKind: r.identifierKind,
      purchaseDate: r.purchaseDate,
      warehouse: r.warehouse,
      hash: hashes.get(r.id),
    }))
}

function itemRows(batch: SyncBatch, receiptIds: Set<string>) {
  return batch.receipts
    .filter((r) => receiptIds.has(r.id))
    .flatMap((r) => r.items.map((item) => ({ ...item, receiptId: r.id })))
}

export async function applyBatch(
  db: SqlDatabase,
  principal: Principal,
  runId: string,
  seq: number,
  body: unknown,
  now: Date,
) {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 10_000) {
    throw new ApiError(400, 'invalid_seq', 'Batch sequence numbers are integers from 0 to 9999.')
  }
  const payloadHash = await hashCanonical(body)
  const run = await loadRun(db, principal, runId)

  const replay = async () => {
    const prior = await db.first<{ payload_sha256: string; result_json: string }>(
      'SELECT payload_sha256, result_json FROM sync_batches WHERE run_id = ? AND seq = ?',
      [runId, seq],
    )
    if (!prior) return null
    if (prior.payload_sha256 !== payloadHash) {
      throw new ApiError(409, 'batch_conflict', `Batch ${seq} was already received with different content.`)
    }
    return { runId, seq, replayed: true, counts: JSON.parse(prior.result_json) as BatchCounts }
  }

  const prior = await replay()
  if (prior) return prior
  if (run.status !== 'open') throw new ApiError(409, 'run_not_open', `Sync run is ${run.status}.`)

  const validation = validateSyncBatch(body)
  if (!validation.ok) {
    const status = validation.code === 'batch_too_large' ? 413 : 400
    throw new ApiError(status, validation.code, 'The batch was rejected; nothing was stored.', validation.issues)
  }
  const batch = validation.batch
  await checkReferences(db, batch)

  const incoming = await hashBatch(batch)
  const stored = {
    receipts: await storedStates(db, 'receipts', [...incoming.receipts.keys()]),
    returns: await storedStates(db, 'returns', [...incoming.returns.keys()]),
    priceAdjustments: await storedStates(db, 'priceAdjustments', [...incoming.priceAdjustments.keys()]),
  }
  const plan = planBatch(incoming, stored)

  const changedReceipts = new Set([...plan.receipts.insert, ...plan.receipts.update])
  const items = itemRows(batch, changedReceipts)
  const counts = countPlan(plan, items.length)
  const iso = now.toISOString()

  const statements: Statement[] = [
    NEXT_SEQ,
    sql(
      `INSERT INTO sync_batches (run_id, seq, payload_sha256, result_json, change_seq, received_at)
       VALUES (?, ?, ?, ?, ${CURRENT_SEQ}, ?)`,
      runId,
      seq,
      payloadHash,
      JSON.stringify(counts),
      iso,
    ),
  ]

  if (changedReceipts.size > 0) {
    statements.push(
      sql(
        `INSERT INTO receipts (id, source_type, identifier_kind, purchase_date, warehouse, bundle_hash,
                               first_seen_run_id, last_changed_run_id, missing_since_run_id, change_seq, created_at, updated_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.sourceType'), json_extract(value, '$.identifierKind'),
                json_extract(value, '$.purchaseDate'), json_extract(value, '$.warehouse'), json_extract(value, '$.hash'),
                ?, ?, NULL, ${CURRENT_SEQ}, ?, ?
         FROM json_each(?) WHERE true
         ON CONFLICT(id) DO UPDATE SET
           source_type = excluded.source_type, identifier_kind = excluded.identifier_kind,
           purchase_date = excluded.purchase_date, warehouse = excluded.warehouse, bundle_hash = excluded.bundle_hash,
           last_changed_run_id = excluded.last_changed_run_id, missing_since_run_id = NULL,
           change_seq = excluded.change_seq, updated_at = excluded.updated_at`,
        runId,
        runId,
        iso,
        iso,
        JSON.stringify(receiptRows(batch, changedReceipts, incoming.receipts)),
      ),
      // A receipt bundle replaces its item set, exactly as the iOS app does.
      sql('DELETE FROM items WHERE receipt_id IN (SELECT value FROM json_each(?))', ids(plan.receipts.update)),
    )
    if (items.length > 0) {
      statements.push(
        sql(
          `INSERT INTO items (id, receipt_id, item_number, description, quantity, line_total_cents, unit_price_cents)
           SELECT json_extract(value, '$.id'), json_extract(value, '$.receiptId'), json_extract(value, '$.itemNumber'),
                  json_extract(value, '$.description'), json_extract(value, '$.quantity'),
                  json_extract(value, '$.lineTotalCents'), json_extract(value, '$.unitPriceCents')
           FROM json_each(?)`,
          JSON.stringify(items),
        ),
      )
    }
  }

  const changedReturns = new Set([...plan.returns.insert, ...plan.returns.update])
  if (changedReturns.size > 0) {
    statements.push(
      sql(
        `INSERT INTO item_returns (id, transaction_id, item_number, return_date, warehouse, quantity, description,
                                   transaction_type, merchandise_amount_cents, transaction_total_cents, source_purchase_id,
                                   content_hash, first_seen_run_id, last_changed_run_id, missing_since_run_id, change_seq,
                                   created_at, updated_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.transactionId'), json_extract(value, '$.itemNumber'),
                json_extract(value, '$.returnDate'), json_extract(value, '$.warehouse'), json_extract(value, '$.quantity'),
                json_extract(value, '$.description'), json_extract(value, '$.transactionType'),
                json_extract(value, '$.merchandiseAmountCents'), json_extract(value, '$.transactionTotalCents'),
                json_extract(value, '$.sourcePurchaseId'), json_extract(value, '$.hash'),
                ?, ?, NULL, ${CURRENT_SEQ}, ?, ?
         FROM json_each(?) WHERE true
         ON CONFLICT(id) DO UPDATE SET
           transaction_id = excluded.transaction_id, item_number = excluded.item_number, return_date = excluded.return_date,
           warehouse = excluded.warehouse, quantity = excluded.quantity, description = excluded.description,
           transaction_type = excluded.transaction_type, merchandise_amount_cents = excluded.merchandise_amount_cents,
           transaction_total_cents = excluded.transaction_total_cents, source_purchase_id = excluded.source_purchase_id,
           content_hash = excluded.content_hash, last_changed_run_id = excluded.last_changed_run_id,
           missing_since_run_id = NULL, change_seq = excluded.change_seq, updated_at = excluded.updated_at`,
        runId,
        runId,
        iso,
        iso,
        JSON.stringify(
          batch.returns.filter((r) => changedReturns.has(r.id)).map((r) => ({ ...r, hash: incoming.returns.get(r.id) })),
        ),
      ),
    )
  }

  const changedAdjustments = new Set([...plan.priceAdjustments.insert, ...plan.priceAdjustments.update])
  if (changedAdjustments.size > 0) {
    statements.push(
      sql(
        `INSERT INTO price_adjustments (id, transaction_id, item_number, adjustment_date, warehouse, amount_cents,
                                        adjusted_quantity, reference_line_numbers, transaction_type, transaction_total_cents,
                                        source_purchase_id, content_hash, first_seen_run_id, last_changed_run_id,
                                        missing_since_run_id, change_seq, created_at, updated_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.transactionId'), json_extract(value, '$.itemNumber'),
                json_extract(value, '$.adjustmentDate'), json_extract(value, '$.warehouse'), json_extract(value, '$.amountCents'),
                json_extract(value, '$.adjustedQuantity'), json_extract(value, '$.referenceLineNumbers'),
                json_extract(value, '$.transactionType'), json_extract(value, '$.transactionTotalCents'),
                json_extract(value, '$.sourcePurchaseId'), json_extract(value, '$.hash'),
                ?, ?, NULL, ${CURRENT_SEQ}, ?, ?
         FROM json_each(?) WHERE true
         ON CONFLICT(id) DO UPDATE SET
           transaction_id = excluded.transaction_id, item_number = excluded.item_number,
           adjustment_date = excluded.adjustment_date, warehouse = excluded.warehouse, amount_cents = excluded.amount_cents,
           adjusted_quantity = excluded.adjusted_quantity, reference_line_numbers = excluded.reference_line_numbers,
           transaction_type = excluded.transaction_type, transaction_total_cents = excluded.transaction_total_cents,
           source_purchase_id = excluded.source_purchase_id, content_hash = excluded.content_hash,
           last_changed_run_id = excluded.last_changed_run_id, missing_since_run_id = NULL,
           change_seq = excluded.change_seq, updated_at = excluded.updated_at`,
        runId,
        runId,
        iso,
        iso,
        JSON.stringify(
          batch.priceAdjustments
            .filter((a) => changedAdjustments.has(a.id))
            .map((a) => ({ ...a, hash: incoming.priceAdjustments.get(a.id) })),
        ),
      ),
    )
  }

  for (const kind of ['receipts', 'returns', 'priceAdjustments'] as const) {
    if (plan[kind].revive.length === 0) continue
    statements.push(
      sql(
        `UPDATE ${TABLE[kind]} SET missing_since_run_id = NULL, last_changed_run_id = ?, change_seq = ${CURRENT_SEQ}, updated_at = ?
         WHERE id IN (SELECT value FROM json_each(?))`,
        runId,
        iso,
        ids(plan[kind].revive),
      ),
    )
  }

  statements.push(
    sql(
      `UPDATE sync_runs SET batch_count = batch_count + 1,
         receipts_inserted = receipts_inserted + ?, receipts_updated = receipts_updated + ?,
         receipts_revived = receipts_revived + ?, receipts_unchanged = receipts_unchanged + ?,
         items_written = items_written + ?,
         returns_inserted = returns_inserted + ?, returns_updated = returns_updated + ?,
         returns_revived = returns_revived + ?, returns_unchanged = returns_unchanged + ?,
         adjustments_inserted = adjustments_inserted + ?, adjustments_updated = adjustments_updated + ?,
         adjustments_revived = adjustments_revived + ?, adjustments_unchanged = adjustments_unchanged + ?
       WHERE id = ?`,
      counts.receipts.inserted,
      counts.receipts.updated,
      counts.receipts.revived,
      counts.receipts.unchanged,
      counts.itemsWritten,
      counts.returns.inserted,
      counts.returns.updated,
      counts.returns.revived,
      counts.returns.unchanged,
      counts.priceAdjustments.inserted,
      counts.priceAdjustments.updated,
      counts.priceAdjustments.revived,
      counts.priceAdjustments.unchanged,
      runId,
    ),
  )

  try {
    await db.batch(statements)
  } catch (error) {
    if (error instanceof ConstraintError) {
      // A concurrent identical request may have won the race.
      const raced = await replay()
      if (raced) return raced
      throw new ApiError(409, 'constraint_violation', 'The batch conflicts with stored data; nothing was stored.')
    }
    throw error
  }
  return { runId, seq, replayed: false, counts }
}

// ── Complete / abort / review ───────────────────────────────────────────────

async function liveIds(db: SqlDatabase, kind: RecordKind): Promise<string[]> {
  const rows = await db.all<{ id: string }>(`SELECT id FROM ${TABLE[kind]} WHERE missing_since_run_id IS NULL`)
  return rows.map((r) => r.id)
}

function tombstoneStatements(runId: string, removals: Record<RecordKind, string[]>, iso: string): Statement[] {
  const out: Statement[] = []
  for (const kind of ['receipts', 'returns', 'priceAdjustments'] as const) {
    if (removals[kind].length === 0) continue
    out.push(
      sql(
        `UPDATE ${TABLE[kind]} SET missing_since_run_id = ?, change_seq = ${CURRENT_SEQ}, updated_at = ?
         WHERE missing_since_run_id IS NULL AND id IN (SELECT value FROM json_each(?))`,
        runId,
        iso,
        ids(removals[kind]),
      ),
    )
  }
  return out.length > 0 ? [NEXT_SEQ, ...out] : out
}

export async function completeRun(db: SqlDatabase, principal: Principal, runId: string, body: unknown, now: Date) {
  const req = parseWith(completeRunSchema, body)
  const run = await loadRun(db, principal, runId)
  if (run.status === 'completed' || run.status === 'needs_review') return { run: publicRun(run) }
  if (run.status !== 'open') throw new ApiError(409, 'run_not_open', `Sync run is ${run.status}.`)

  const batches = await db.all<{ seq: number; result_json: string }>(
    'SELECT seq, result_json FROM sync_batches WHERE run_id = ? ORDER BY seq',
    [runId],
  )
  const received = new Set(batches.map((b) => b.seq))
  const missing = Array.from({ length: req.batchCount }, (_, i) => i).filter((i) => !received.has(i))
  const unexpected = [...received].filter((s) => s >= req.batchCount)
  if (missing.length > 0 || unexpected.length > 0) {
    throw new ApiError(409, 'missing_batches', 'The server does not hold exactly the batches 0…batchCount-1.', [], {
      missingSeqs: missing.slice(0, 500),
      unexpectedSeqs: unexpected.slice(0, 500),
    })
  }

  const iso = now.toISOString()
  let status: 'completed' | 'needs_review' = 'completed'
  const statements: Statement[] = []
  let markedMissing = 0

  if (run.mode === 'full') {
    if (!req.manifest) throw new ApiError(400, 'manifest_required', 'A full sync must send a manifest of all IDs.')
    const manifest = {
      receipts: req.manifest.receiptIds,
      returns: req.manifest.returnIds,
      priceAdjustments: req.manifest.priceAdjustmentIds,
    }
    const sent = { receipts: 0, returns: 0, priceAdjustments: 0 }
    for (const b of batches) {
      const counts = JSON.parse(b.result_json) as BatchCounts
      for (const kind of ['receipts', 'returns', 'priceAdjustments'] as const) sent[kind] += counts.rows[kind]
    }
    for (const kind of ['receipts', 'returns', 'priceAdjustments'] as const) {
      if (new Set(manifest[kind]).size !== manifest[kind].length) {
        throw new ApiError(400, 'invalid_manifest', `The ${kind} manifest contains duplicate IDs.`)
      }
      if (manifest[kind].length !== sent[kind]) {
        throw new ApiError(
          409,
          'manifest_mismatch',
          `The ${kind} manifest lists ${manifest[kind].length} IDs but this run sent ${sent[kind]} rows.`,
        )
      }
    }

    const removals = {} as Record<RecordKind, string[]>
    let guardTripped = false
    for (const kind of ['receipts', 'returns', 'priceAdjustments'] as const) {
      const p = planMissing(await liveIds(db, kind), manifest[kind])
      removals[kind] = p.toTombstone
      guardTripped ||= p.guardTripped
    }
    if (guardTripped) {
      status = 'needs_review'
      statements.push(sql('UPDATE sync_runs SET pending_removals_json = ? WHERE id = ?', JSON.stringify(removals), runId))
    } else {
      markedMissing = removals.receipts.length + removals.returns.length + removals.priceAdjustments.length
      statements.push(...tombstoneStatements(runId, removals, iso))
    }
  } else if (req.manifest) {
    throw new ApiError(400, 'manifest_not_allowed', 'Only full syncs send a manifest.')
  }

  statements.push(
    sql(
      'UPDATE sync_runs SET status = ?, finished_at = ?, marked_missing = ? WHERE id = ?',
      status,
      iso,
      markedMissing,
      runId,
    ),
  )
  if (run.request_id) {
    statements.push(
      sql(
        "UPDATE sync_requests SET status = 'fulfilled', fulfilled_run_id = ?, fulfilled_at = ? WHERE id = ? AND status IN ('pending', 'acknowledged')",
        runId,
        iso,
        run.request_id,
      ),
    )
  }
  await db.batch(statements)
  return { run: publicRun(await loadRun(db, principal, runId)) }
}

/** Owner confirms the tombstoning that the mass-removal guard held back. */
export async function confirmRemovals(db: SqlDatabase, principal: Principal, runId: string, now: Date) {
  if (principal.kind !== 'owner') throw new ApiError(403, 'forbidden', 'Only the owner can confirm removals.')
  const run = await loadRun(db, principal, runId)
  if (run.status !== 'needs_review' || !run.pending_removals_json) {
    throw new ApiError(409, 'nothing_to_confirm', 'This run has no removals awaiting review.')
  }
  const removals = JSON.parse(run.pending_removals_json) as Record<RecordKind, string[]>
  const iso = now.toISOString()
  const results = await db.batch([
    ...tombstoneStatements(runId, removals, iso),
    sql("UPDATE sync_runs SET status = 'completed', pending_removals_json = NULL WHERE id = ?", runId),
  ])
  // Rows revived by a later sync are skipped by the `missing_since_run_id IS NULL` guard; count real changes.
  const marked = results.slice(1, -1).reduce((n, r) => n + r.changes, 0)
  await db.run('UPDATE sync_runs SET marked_missing = ? WHERE id = ?', [marked, runId])
  return { run: publicRun(await loadRun(db, principal, runId)) }
}

export async function abortRun(db: SqlDatabase, principal: Principal, runId: string, now: Date) {
  const run = await loadRun(db, principal, runId)
  if (run.status === 'open') {
    await db.run("UPDATE sync_runs SET status = 'aborted', finished_at = ? WHERE id = ? AND status = 'open'", [
      now.toISOString(),
      runId,
    ])
  }
  return { run: publicRun(await loadRun(db, principal, runId)) }
}

export async function getRun(db: SqlDatabase, principal: Principal, runId: string) {
  const run = await loadRun(db, principal, runId)
  const seqs = await db.all<{ seq: number }>('SELECT seq FROM sync_batches WHERE run_id = ? ORDER BY seq', [runId])
  return { run: publicRun(run), receivedSeqs: seqs.map((s) => s.seq) }
}

export async function listRuns(db: SqlDatabase, limit: number) {
  const runs = await db.all<RunRow>('SELECT * FROM sync_runs ORDER BY started_at DESC, id LIMIT ?', [limit])
  return { runs: runs.map(publicRun) }
}
