/**
 * The analytics engine's view of one validated Analytics Export V1 dataset.
 *
 * Both data sources produce the same `AnalyticsExportV1`:
 * - local mode: a JSON export validated by `importExportText`;
 * - cloud mode: owner-only paginated `/api/export/*` pages reassembled and
 *   validated by the same importer (`src/cloud/cloudDataset.ts`).
 * So there is exactly one analytics implementation. `buildIndex` joins items
 * to their receipt once; every analytics module reads this index.
 */
import type {
  AnalyticsExportV1,
  PriceAdjustment,
  ReceiptIdentifierKind,
  ReceiptSourceType,
  Return,
} from '../domain/export/v1'
import { dayNumber, monthKey, yearOf, type MonthKey } from './dates'
import { cleanQuantity } from './stats'

/** One receipt or online order: a "purchase event". */
export type PurchaseEvent = {
  id: string
  sourceType: ReceiptSourceType
  identifierKind: ReceiptIdentifierKind
  date: string | null
  day: number | null
  month: MonthKey | null
  year: number | null
  warehouse: string | null
  lineIds: string[]
  lineCount: number
  /** Σ quantity of the event's item lines (fractional quantities allowed). */
  units: number
  /**
   * Estimated basket = Σ item lineTotalCents (net of instant savings, pre-tax).
   * The export has no receipt total, so tax and any line the iOS app could not
   * export are not included. Null when the event has no exported item lines.
   */
  basketCents: number | null
}

/** One item line, joined with its purchase event. */
export type PurchaseLine = {
  id: string
  receiptId: string
  itemNumber: string
  description: string
  quantity: number
  lineTotalCents: number
  /** Only as recorded; never derived from lineTotal / quantity. */
  unitPriceCents: number | null
  date: string | null
  day: number | null
  month: MonthKey | null
  year: number | null
  sourceType: ReceiptSourceType
  warehouse: string | null
}

export type AnalyticsIndex = {
  data: AnalyticsExportV1
  events: PurchaseEvent[]
  eventsById: Map<string, PurchaseEvent>
  /** Ordered by date (undated last), then receipt ID, then line ID. */
  lines: PurchaseLine[]
  linesByItem: Map<string, PurchaseLine[]>
  returns: Return[]
  adjustments: PriceAdjustment[]
  /** Reference date for "days since" and rolling windows (YYYY-MM-DD) or null if the dataset has no dates. */
  asOf: string | null
  asOfDay: number | null
}

const byDateThenId = (a: { day: number | null; id: string }, b: { day: number | null; id: string }) => {
  if (a.day !== b.day) {
    if (a.day === null) return 1
    if (b.day === null) return -1
    return a.day - b.day
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function buildIndex(data: AnalyticsExportV1, asOf?: string | null): AnalyticsIndex {
  const linesByReceipt = new Map<string, AnalyticsExportV1['items']>()
  for (const item of data.items) {
    const list = linesByReceipt.get(item.purchaseId)
    if (list) list.push(item)
    else linesByReceipt.set(item.purchaseId, [item])
  }

  const events: PurchaseEvent[] = []
  const lines: PurchaseLine[] = []
  for (const receipt of data.receipts) {
    const date = receipt.purchaseDate
    const day = date === null ? null : dayNumber(date)
    const month = date === null ? null : monthKey(date)
    const year = date === null ? null : yearOf(date)
    const items = (linesByReceipt.get(receipt.id) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1))
    let basket = 0
    let units = 0
    for (const item of items) {
      basket += item.lineTotalCents
      units += item.quantity
      lines.push({
        id: item.id,
        receiptId: receipt.id,
        itemNumber: item.itemNumber,
        description: item.description,
        quantity: item.quantity,
        lineTotalCents: item.lineTotalCents,
        unitPriceCents: item.unitPriceCents,
        date,
        day,
        month,
        year,
        sourceType: receipt.sourceType,
        warehouse: receipt.warehouse,
      })
    }
    events.push({
      id: receipt.id,
      sourceType: receipt.sourceType,
      identifierKind: receipt.identifierKind,
      date,
      day,
      month,
      year,
      warehouse: receipt.warehouse,
      lineIds: items.map((i) => i.id),
      lineCount: items.length,
      units: cleanQuantity(units),
      basketCents: items.length === 0 ? null : basket,
    })
  }
  events.sort(byDateThenId)
  lines.sort((a, b) => byDateThenId({ day: a.day, id: a.receiptId }, { day: b.day, id: b.receiptId }) || (a.id < b.id ? -1 : 1))

  const linesByItem = new Map<string, PurchaseLine[]>()
  for (const line of lines) {
    const list = linesByItem.get(line.itemNumber)
    if (list) list.push(line)
    else linesByItem.set(line.itemNumber, [line])
  }

  const resolvedAsOf = asOf === undefined ? latestDate(data) : asOf
  return {
    data,
    events,
    eventsById: new Map(events.map((e) => [e.id, e])),
    lines,
    linesByItem,
    returns: data.returns,
    adjustments: data.priceAdjustments,
    asOf: resolvedAsOf,
    asOfDay: resolvedAsOf === null ? null : dayNumber(resolvedAsOf),
  }
}

/** The latest date anywhere in the dataset (purchases, returns, adjustments). */
export function latestDate(data: AnalyticsExportV1): string | null {
  let latest: string | null = null
  const consider = (d: string | null) => {
    if (d !== null && (latest === null || d > latest)) latest = d
  }
  for (const r of data.receipts) consider(r.purchaseDate)
  for (const r of data.returns) consider(r.returnDate)
  for (const a of data.priceAdjustments) consider(a.adjustmentDate)
  return latest
}

/** A money total that also lists the source records it was computed from. */
export type TracedCents = { cents: number; count: number; ids: string[] }

export function traced(entries: readonly { id: string; cents: number }[]): TracedCents {
  let cents = 0
  for (const e of entries) cents += e.cents
  return { cents, count: entries.length, ids: entries.map((e) => e.id) }
}
