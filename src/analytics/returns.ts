/**
 * Returns. Uses only what the export records:
 * - returned value = merchandiseAmountCents (the item's returned merchandise
 *   value, positive); returns without it are counted, never estimated;
 * - transactionTotalCents is NEVER summed (it is the whole return
 *   transaction, repeated on each of its rows);
 * - returns are matched to purchases only by itemNumber (aggregate level).
 *   Time-to-return needs sourcePurchaseId, which the iOS exporter leaves null,
 *   so it is reported as unavailable instead of being inferred.
 *
 * Return rates (only where a defensible denominator exists):
 * - dollar return rate = Σ known merchandise returned ÷ gross purchase spend;
 * - unit return rate = Σ returned quantity of items also purchased in the data
 *   ÷ Σ purchased quantity of those same items;
 * - per item = returned quantity ÷ purchased quantity (flagged when > 1,
 *   i.e. returns of purchases older than the data).
 */
import { dayNumber, monthKey, type MonthKey } from './dates'
import type { ItemAnalytics } from './items'
import type { AnalyticsIndex } from './model'
import { cleanQuantity, mean, median, ratio } from './stats'

export type ReturnBucket = { count: number; quantity: number; amountCents: number; ids: string[] }

export type ItemReturnSummary = {
  itemNumber: string
  description: string
  count: number
  quantity: number
  amountCents: number
  purchasedQuantity: number
  /** returned ÷ purchased quantity; null if the item was not purchased in the data. */
  returnRate: number | null
  returnsExceedPurchases: boolean
}

export type ReturnAnalytics = {
  count: number
  quantity: number
  amountCents: number
  withoutAmount: { count: number; ids: string[] }
  distinctTransactions: number
  byMonth: (ReturnBucket & { month: MonthKey })[]
  byYear: (ReturnBucket & { year: number })[]
  undated: ReturnBucket
  topByCount: ItemReturnSummary[]
  topByAmount: ItemReturnSummary[]
  items: ItemReturnSummary[]
  dollarReturnRate: number | null
  unitReturnRate: number | null
  timeToReturn: { available: false; reason: string } | { available: true; linkedReturns: number; averageDays: number | null; medianDays: number | null }
}

const empty = (): ReturnBucket => ({ count: 0, quantity: 0, amountCents: 0, ids: [] })

export function computeReturns(index: AnalyticsIndex, items: ItemAnalytics, grossCents: number, topN: number): ReturnAnalytics {
  const months = new Map<MonthKey, ReturnBucket>()
  const undated = empty()
  const total = empty()
  const add = (b: ReturnBucket, r: (typeof index.returns)[number]) => {
    b.count += 1
    b.quantity = cleanQuantity(b.quantity + r.quantity)
    b.amountCents += r.merchandiseAmountCents ?? 0
    b.ids.push(r.id)
  }
  for (const r of index.returns) {
    add(total, r)
    if (r.returnDate === null) add(undated, r)
    else {
      const m = monthKey(r.returnDate)
      const b = months.get(m) ?? empty()
      add(b, r)
      months.set(m, b)
    }
  }
  const byMonth = [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, b]) => ({ ...b, month }))
  const years = new Map<number, ReturnBucket>()
  for (const m of byMonth) {
    const y = Number(m.month.slice(0, 4))
    const b = years.get(y) ?? empty()
    b.count += m.count
    b.quantity = cleanQuantity(b.quantity + m.quantity)
    b.amountCents += m.amountCents
    b.ids.push(...m.ids)
    years.set(y, b)
  }

  const summaries: ItemReturnSummary[] = items.items
    .filter((i) => i.returns.count > 0)
    .map((i) => {
      const rate = i.totalQuantity > 0 ? ratio(i.returns.quantity, i.totalQuantity) : null
      return {
        itemNumber: i.itemNumber,
        description: i.displayDescription,
        count: i.returns.count,
        quantity: i.returns.quantity,
        amountCents: i.returns.amountCents,
        purchasedQuantity: i.totalQuantity,
        returnRate: rate,
        returnsExceedPurchases: rate !== null && rate > 1,
      }
    })
  const tie = (a: ItemReturnSummary, b: ItemReturnSummary) => (a.itemNumber < b.itemNumber ? -1 : 1)

  const matched = summaries.filter((s) => s.purchasedQuantity > 0)
  const linked = index.returns.filter((r) => r.sourcePurchaseId !== null && r.returnDate !== null)
  let timeToReturn: ReturnAnalytics['timeToReturn'] = {
    available: false,
    reason: 'Returns are not linked to specific purchases in this data (sourcePurchaseId is empty), so time-to-return cannot be measured.',
  }
  if (linked.length > 0) {
    const days = linked
      .map((r) => {
        const purchase = index.eventsById.get(r.sourcePurchaseId!)
        return purchase && purchase.day !== null ? dayNumber(r.returnDate!) - purchase.day : null
      })
      .filter((d): d is number => d !== null)
    timeToReturn = { available: true, linkedReturns: days.length, averageDays: mean(days), medianDays: median(days) }
  }

  return {
    count: total.count,
    quantity: total.quantity,
    amountCents: total.amountCents,
    withoutAmount: {
      count: index.returns.filter((r) => r.merchandiseAmountCents === null).length,
      ids: index.returns.filter((r) => r.merchandiseAmountCents === null).map((r) => r.id),
    },
    distinctTransactions: new Set(index.returns.map((r) => r.transactionId)).size,
    byMonth,
    byYear: [...years.entries()].sort(([a], [b]) => a - b).map(([year, b]) => ({ ...b, year })),
    undated,
    topByCount: [...summaries].sort((a, b) => b.count - a.count || b.quantity - a.quantity || tie(a, b)).slice(0, topN),
    topByAmount: [...summaries].sort((a, b) => b.amountCents - a.amountCents || tie(a, b)).slice(0, topN),
    items: summaries,
    dollarReturnRate: grossCents > 0 ? ratio(total.amountCents, grossCents) : null,
    unitReturnRate: ratio(
      matched.reduce((s, m) => s + m.quantity, 0),
      matched.reduce((s, m) => s + m.purchasedQuantity, 0),
    ),
    timeToReturn,
  }
}
