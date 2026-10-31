/**
 * Paginated export of cloud-held analytics data in Export V1 record shapes
 * (docs/CLOUD_ARCHITECTURE.md §7, §10). The browser reassembles an Export V1
 * file and re-validates it with the same importer used for JSON import.
 */
import { EXPORT_FORMAT, FORMAT_VERSION_V1, type Item, type PriceAdjustment, type Receipt, type Return } from '../src/domain/export/v1'
import type { SqlDatabase, SqlValue } from './db'
import { ApiError } from './http'

export const EXPORT_COLLECTIONS = ['receipts', 'items', 'returns', 'priceAdjustments'] as const
export type ExportCollection = (typeof EXPORT_COLLECTIONS)[number]
export const EXPORT_PAGE = { default: 500, max: 1000 } as const

export type ExportRow<T> = { record: T; changeSeq: number; missing: boolean }

type Paging = { after: string | null; limit: number; sinceSeq: number | null; includeMissing: boolean }

export function parsePaging(url: URL): Paging {
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw === null ? EXPORT_PAGE.default : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_PAGE.max) {
    throw new ApiError(400, 'invalid_limit', `limit must be an integer from 1 to ${EXPORT_PAGE.max}.`)
  }
  const sinceRaw = url.searchParams.get('sinceSeq')
  const sinceSeq = sinceRaw === null ? null : Number(sinceRaw)
  if (sinceSeq !== null && (!Number.isInteger(sinceSeq) || sinceSeq < 0)) {
    throw new ApiError(400, 'invalid_since', 'sinceSeq must be a non-negative integer.')
  }
  const includeMissing = url.searchParams.get('includeMissing') === '1' || sinceSeq !== null
  return { after: url.searchParams.get('after'), limit, sinceSeq, includeMissing }
}

type Row = Record<string, SqlValue>

const s = (v: SqlValue | undefined) => v as string
const sn = (v: SqlValue | undefined) => (v ?? null) as string | null
const n = (v: SqlValue | undefined) => v as number
const nn = (v: SqlValue | undefined) => (v ?? null) as number | null

const MAPPERS = {
  receipts: (r: Row): Receipt => ({
    id: s(r.id),
    sourceType: s(r.source_type) as Receipt['sourceType'],
    identifierKind: s(r.identifier_kind) as Receipt['identifierKind'],
    purchaseDate: sn(r.purchase_date),
    warehouse: sn(r.warehouse),
  }),
  items: (r: Row): Item => ({
    id: s(r.id),
    purchaseId: s(r.receipt_id),
    itemNumber: s(r.item_number),
    description: s(r.description),
    quantity: n(r.quantity),
    lineTotalCents: n(r.line_total_cents),
    unitPriceCents: nn(r.unit_price_cents),
  }),
  returns: (r: Row): Return => ({
    id: s(r.id),
    transactionId: s(r.transaction_id),
    itemNumber: s(r.item_number),
    returnDate: sn(r.return_date),
    warehouse: sn(r.warehouse),
    quantity: n(r.quantity),
    description: sn(r.description),
    transactionType: sn(r.transaction_type),
    merchandiseAmountCents: nn(r.merchandise_amount_cents),
    transactionTotalCents: nn(r.transaction_total_cents),
    sourcePurchaseId: sn(r.source_purchase_id),
  }),
  priceAdjustments: (r: Row): PriceAdjustment => ({
    id: s(r.id),
    transactionId: s(r.transaction_id),
    itemNumber: s(r.item_number),
    adjustmentDate: sn(r.adjustment_date),
    warehouse: sn(r.warehouse),
    amountCents: n(r.amount_cents),
    adjustedQuantity: nn(r.adjusted_quantity),
    referenceLineNumbers: JSON.parse(s(r.reference_line_numbers)) as string[],
    transactionType: sn(r.transaction_type),
    transactionTotalCents: n(r.transaction_total_cents),
    sourcePurchaseId: sn(r.source_purchase_id),
  }),
} as const

const SOURCE: Record<ExportCollection, { from: string; select: string }> = {
  receipts: { from: 'receipts t', select: 't.*, t.change_seq AS _seq, t.missing_since_run_id AS _missing' },
  // Items inherit change tracking and tombstones from their receipt.
  items: {
    from: 'items t JOIN receipts p ON p.id = t.receipt_id',
    select: 't.*, p.change_seq AS _seq, p.missing_since_run_id AS _missing',
  },
  returns: { from: 'item_returns t', select: 't.*, t.change_seq AS _seq, t.missing_since_run_id AS _missing' },
  priceAdjustments: {
    from: 'price_adjustments t',
    select: 't.*, t.change_seq AS _seq, t.missing_since_run_id AS _missing',
  },
}

export async function exportPage(db: SqlDatabase, collection: string, url: URL) {
  if (!(EXPORT_COLLECTIONS as readonly string[]).includes(collection)) {
    throw new ApiError(404, 'unknown_collection', 'Unknown export collection.')
  }
  const c = collection as ExportCollection
  const paging = parsePaging(url)
  const where: string[] = []
  const params: SqlValue[] = []
  if (paging.after !== null) {
    where.push('t.id > ?')
    params.push(paging.after)
  }
  if (paging.sinceSeq !== null) {
    where.push(`${c === 'items' ? 'p' : 't'}.change_seq > ?`)
    params.push(paging.sinceSeq)
  }
  if (!paging.includeMissing) where.push(`${c === 'items' ? 'p' : 't'}.missing_since_run_id IS NULL`)
  const rows = await db.all<Row>(
    `SELECT ${SOURCE[c].select} FROM ${SOURCE[c].from}
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY t.id LIMIT ?`,
    [...params, paging.limit + 1],
  )
  const page = rows.slice(0, paging.limit)
  const records = page.map((row) => ({
    record: MAPPERS[c](row),
    changeSeq: n(row._seq),
    missing: row._missing !== null,
  }))
  return { collection: c, records, nextCursor: rows.length > paging.limit ? s(page[page.length - 1]!.id) : null }
}

export async function exportMeta(db: SqlDatabase, now: Date) {
  const currency = await db.first<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'currency'")
  const seq = await db.first<{ value: number }>("SELECT value FROM sequences WHERE name = 'change_seq'")
  const counts = await db.first<Record<string, number>>(
    `SELECT
       (SELECT COUNT(*) FROM receipts WHERE missing_since_run_id IS NULL) AS receipts,
       (SELECT COUNT(*) FROM items i JOIN receipts r ON r.id = i.receipt_id WHERE r.missing_since_run_id IS NULL) AS items,
       (SELECT COUNT(*) FROM item_returns WHERE missing_since_run_id IS NULL) AS returns,
       (SELECT COUNT(*) FROM price_adjustments WHERE missing_since_run_id IS NULL) AS priceAdjustments,
       (SELECT COUNT(*) FROM receipts WHERE missing_since_run_id IS NOT NULL) +
       (SELECT COUNT(*) FROM item_returns WHERE missing_since_run_id IS NOT NULL) +
       (SELECT COUNT(*) FROM price_adjustments WHERE missing_since_run_id IS NOT NULL) AS tombstoned`,
  )
  return {
    format: EXPORT_FORMAT,
    formatVersion: FORMAT_VERSION_V1,
    exportedAt: now.toISOString(),
    /** Null until the first sync fixes the instance currency. */
    currency: currency?.value ?? null,
    changeSeq: seq?.value ?? 0,
    counts,
  }
}
