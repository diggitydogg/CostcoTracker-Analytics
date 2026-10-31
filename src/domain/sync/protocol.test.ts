// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AnalyticsExportV1 } from '../export/v1'
import { importExportValue } from '../import/importExport'
import { syntheticExport } from '../../test/fixtures'
import {
  SYNC_LIMITS,
  batchToExportCollections,
  completeRunSchema,
  countBatchRows,
  findForbiddenKeys,
  startRunSchema,
  toSyncBatches,
  validateSyncBatch,
} from './protocol'

function data(): AnalyticsExportV1 {
  const r = importExportValue(syntheticExport())
  if (!r.ok) throw new Error('fixture')
  return r.data
}

describe('toSyncBatches', () => {
  it('round-trips every record through batches', () => {
    const d = data()
    const batches = toSyncBatches(d, 4)
    const flat = batches.map(batchToExportCollections)
    const sortById = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))
    expect(sortById(flat.flatMap((b) => b.receipts))).toEqual(sortById(d.receipts))
    expect(sortById(flat.flatMap((b) => b.items))).toEqual(sortById(d.items))
    expect(sortById(flat.flatMap((b) => b.returns))).toEqual(sortById(d.returns))
    expect(sortById(flat.flatMap((b) => b.priceAdjustments))).toEqual(sortById(d.priceAdjustments))
  })

  it('respects the row limit and keeps receipts with their items and transactions whole', () => {
    const batches = toSyncBatches(data(), 4)
    for (const b of batches) {
      expect(countBatchRows(b)).toBeLessThanOrEqual(4)
      expect(validateSyncBatch(b).ok).toBe(true)
    }
    const withTxn1 = batches.filter((b) => b.returns.some((r) => r.transactionId === 't_synthetic0001'))
    expect(withTxn1).toHaveLength(1)
    expect(withTxn1[0]!.returns.filter((r) => r.transactionId === 't_synthetic0001')).toHaveLength(2)
  })

  it('produces one empty batch for an empty export', () => {
    const empty = { ...data(), receipts: [], items: [], returns: [], priceAdjustments: [] }
    expect(toSyncBatches(empty)).toEqual([{ receipts: [], returns: [], priceAdjustments: [] }])
  })

  it('refuses a receipt that cannot fit in any batch', () => {
    expect(() => toSyncBatches(data(), 2)).toThrow(/limit is 2/)
  })
})

describe('validateSyncBatch', () => {
  const batch = () => toSyncBatches(data(), SYNC_LIMITS.maxRowsPerBatch)[0]!

  it('accepts a valid batch', () => {
    const v = validateSyncBatch(batch())
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.rowCount).toBe(16)
  })

  it('rejects credential-like and barcode fields at any depth, reporting paths only', () => {
    const raw = structuredClone(batch()) as unknown as Record<string, any>
    raw.receipts[0].items[0].sessionToken = 'SECRET-1'
    raw.returns[0].transactionBarcode = 'SECRET-2'
    raw.authorization = 'SECRET-3'
    const v = validateSyncBatch(raw)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.code).toBe('forbidden_field')
    expect(v.issues.map((i) => i.path).sort()).toEqual(
      ['authorization', 'receipts[0].items[0].sessionToken', 'returns[0].transactionBarcode'].sort(),
    )
    expect(JSON.stringify(v)).not.toContain('SECRET')
  })

  it('applies the importer integrity rules inside a batch', () => {
    const raw = structuredClone(batch())
    raw.returns[1] = { ...raw.returns[1]!, transactionTotalCents: 1 }
    const v = validateSyncBatch(raw)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.issues[0]!.path).toBe('returns[1].transactionId')
  })

  it('detects duplicate item IDs across bundles', () => {
    const raw = structuredClone(batch())
    raw.receipts[1]!.items[0]!.id = raw.receipts[0]!.items[0]!.id
    const v = validateSyncBatch(raw)
    expect(v.ok).toBe(false)
  })

  it('allows sourcePurchaseId to reference a receipt outside the batch (resolved by the server)', () => {
    const raw = structuredClone(batch())
    raw.returns[0] = { ...raw.returns[0]!, sourcePurchaseId: 'r_elsewhere' }
    raw.returns[1] = { ...raw.returns[1]!, sourcePurchaseId: 'r_elsewhere' }
    expect(validateSyncBatch(raw).ok).toBe(true)
  })

  it('rejects batches over the row limit', () => {
    const receipts = Array.from({ length: SYNC_LIMITS.maxRowsPerBatch + 1 }, (_, i) => ({
      id: `r_${i}`, sourceType: 'synthetic', identifierKind: 'synthetic', purchaseDate: null, warehouse: null, items: [],
    }))
    const v = validateSyncBatch({ receipts, returns: [], priceAdjustments: [] })
    expect(v.ok === false && v.code).toBe('batch_too_large')
  })

  it('checks sourceType/identifierKind on receipt bundles', () => {
    const raw = structuredClone(batch()) as unknown as Record<string, any>
    raw.receipts[0].identifierKind = 'onlineOrderKey'
    const v = validateSyncBatch(raw)
    expect(v.ok === false && v.issues[0]!.path).toBe('receipts[0].identifierKind')
  })
})

describe('request schemas', () => {
  it('validates run start requests', () => {
    const base = { runId: '00000000-0000-4000-8000-000000000001', mode: 'full', formatVersion: 1, exportedAt: '2026-10-31T18:00:00Z', currency: 'USD' }
    expect(startRunSchema.safeParse(base).success).toBe(true)
    expect(startRunSchema.parse(base).requestId).toBeNull()
    expect(startRunSchema.safeParse({ ...base, runId: 'not-a-uuid' }).success).toBe(false)
    expect(startRunSchema.safeParse({ ...base, formatVersion: 2 }).success).toBe(false)
    expect(startRunSchema.safeParse({ ...base, mode: 'mirror' }).success).toBe(false)
  })

  it('validates completion requests', () => {
    expect(completeRunSchema.parse({ batchCount: 0 }).manifest).toBeNull()
    expect(completeRunSchema.safeParse({ batchCount: -1 }).success).toBe(false)
  })
})

describe('findForbiddenKeys', () => {
  it('finds nothing in an ordinary Export V1 record set', () => {
    expect(findForbiddenKeys(syntheticExport())).toEqual([])
  })
})
