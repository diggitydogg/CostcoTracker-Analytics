/**
 * Pure reconciliation planning (docs/CLOUD_ARCHITECTURE.md §6). The server
 * reads the stored hashes, calls these functions, and executes the plan. No I/O.
 */
import { hashCanonical } from './canonical'
import type { ReceiptBundle, SyncBatch } from './protocol'

export type RecordKind = 'receipts' | 'returns' | 'priceAdjustments'

/** Hash of a receipt *bundle*: the receipt plus its items sorted by ID. */
export function hashReceiptBundle(bundle: ReceiptBundle): Promise<string> {
  const items = [...bundle.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return hashCanonical({ ...bundle, items })
}

export function hashRecord(record: object): Promise<string> {
  return hashCanonical(record)
}

export type IncomingHashes = Record<RecordKind, Map<string, string>>

export async function hashBatch(batch: SyncBatch): Promise<IncomingHashes> {
  const [receipts, returns, priceAdjustments] = await Promise.all([
    Promise.all(batch.receipts.map(async (r) => [r.id, await hashReceiptBundle(r)] as const)),
    Promise.all(batch.returns.map(async (r) => [r.id, await hashRecord(r)] as const)),
    Promise.all(batch.priceAdjustments.map(async (r) => [r.id, await hashRecord(r)] as const)),
  ])
  return { receipts: new Map(receipts), returns: new Map(returns), priceAdjustments: new Map(priceAdjustments) }
}

export type StoredState = { hash: string; missing: boolean }

export type KindPlan = {
  insert: string[]
  update: string[]
  /** Same content, previously tombstoned: clear the tombstone only. */
  revive: string[]
  unchanged: string[]
}

export type BatchPlan = Record<RecordKind, KindPlan>

/**
 * Decides, per incoming record, whether it is new, changed, revived, or
 * unchanged. Unchanged records cost no writes.
 */
export function planKind(incoming: Map<string, string>, stored: Map<string, StoredState>): KindPlan {
  const plan: KindPlan = { insert: [], update: [], revive: [], unchanged: [] }
  for (const [id, hash] of incoming) {
    const existing = stored.get(id)
    if (!existing) plan.insert.push(id)
    else if (existing.hash !== hash) plan.update.push(id)
    else if (existing.missing) plan.revive.push(id)
    else plan.unchanged.push(id)
  }
  return plan
}

export function planBatch(incoming: IncomingHashes, stored: Record<RecordKind, Map<string, StoredState>>): BatchPlan {
  return {
    receipts: planKind(incoming.receipts, stored.receipts),
    returns: planKind(incoming.returns, stored.returns),
    priceAdjustments: planKind(incoming.priceAdjustments, stored.priceAdjustments),
  }
}

export type BatchCounts = Record<RecordKind, { inserted: number; updated: number; revived: number; unchanged: number }> & {
  itemsWritten: number
  rows: Record<RecordKind, number>
}

export function countPlan(plan: BatchPlan, itemsWritten: number): BatchCounts {
  const c = (p: KindPlan) => ({
    inserted: p.insert.length,
    updated: p.update.length,
    revived: p.revive.length,
    unchanged: p.unchanged.length,
  })
  const total = (p: KindPlan) => p.insert.length + p.update.length + p.revive.length + p.unchanged.length
  return {
    receipts: c(plan.receipts),
    returns: c(plan.returns),
    priceAdjustments: c(plan.priceAdjustments),
    itemsWritten,
    rows: { receipts: total(plan.receipts), returns: total(plan.returns), priceAdjustments: total(plan.priceAdjustments) },
  }
}

/** Mass-removal guard thresholds (§6.3). */
export const MASS_REMOVAL_GUARD = { maxFraction: 0.2, maxRows: 50 } as const

export type MissingPlan = { toTombstone: string[]; guardTripped: boolean }

/**
 * Full-mode reconciliation for one table: rows that are stored (and not already
 * tombstoned) but absent from the client's manifest. Trips the guard instead of
 * tombstoning when the removal looks like a wiped or partial source database.
 */
export function planMissing(storedLiveIds: Iterable<string>, manifestIds: Iterable<string>): MissingPlan {
  const manifest = new Set(manifestIds)
  const live = [...storedLiveIds]
  const toTombstone = live.filter((id) => !manifest.has(id)).sort()
  const guardTripped =
    toTombstone.length > MASS_REMOVAL_GUARD.maxRows ||
    (live.length > 0 && toTombstone.length / live.length > MASS_REMOVAL_GUARD.maxFraction)
  return { toTombstone, guardTripped }
}
