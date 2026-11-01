/**
 * Price adjustments (recorded refunds of a price difference — not price-match
 * opportunities). Amounts are adjustment.amountCents (positive savings);
 * transactionTotalCents is never summed.
 *
 * OBSERVED RATIOS, NOT SAVINGS RATES. Adjustments are not linked to the
 * purchase they adjust (sourcePurchaseId is null), so an adjustment may relate
 * to a purchase outside the observed data. These are descriptive ratios:
 * - observedAdjustmentValueRatio = Σ adjustment amounts ÷ observed gross spend
 *   ("Price adjustments as % of observed spend");
 * - observedAdjustedItemsValueRatio = Σ adjustments on items purchased in the
 *   data ÷ observed spend on those items (matched by item number only);
 * - per item observedValueRatio = item adjustments ÷ item observed spend.
 * `purchaseLinkedSavingsRate` states whether a true linked rate is available.
 */
import { monthKey, type MonthKey } from './dates'
import type { ItemAnalytics } from './items'
import { purchaseLinkedRate, type PurchaseLinkedRate } from './linkage'
import type { AnalyticsIndex } from './model'
import { ratio, roundCents } from './stats'

export type AdjustmentBucket = { count: number; amountCents: number; ids: string[] }

export type ItemAdjustmentSummary = {
  itemNumber: string
  description: string
  count: number
  amountCents: number
  itemSpendCents: number
  /** Adjustments ÷ observed item spend in this dataset (not purchase-linked); null if not purchased in the data. */
  observedValueRatio: number | null
}

export type AdjustmentAnalytics = {
  count: number
  totalCents: number
  averageCents: number | null
  largest: { id: string; itemNumber: string; amountCents: number; date: string | null } | null
  distinctTransactions: number
  byMonth: (AdjustmentBucket & { month: MonthKey })[]
  byYear: (AdjustmentBucket & { year: number })[]
  undated: AdjustmentBucket
  topByCount: ItemAdjustmentSummary[]
  topByAmount: ItemAdjustmentSummary[]
  items: ItemAdjustmentSummary[]
  /** Price adjustments as % of observed spend. Descriptive, not purchase-linked. */
  observedAdjustmentValueRatio: number | null
  /** Adjustments ÷ observed spend on the same item numbers. Descriptive, not purchase-linked. */
  observedAdjustedItemsValueRatio: number | null
  /** A true purchase-linked savings rate; unavailable unless every adjustment has a sourcePurchaseId found in the data. */
  purchaseLinkedSavingsRate: PurchaseLinkedRate
}

const empty = (): AdjustmentBucket => ({ count: 0, amountCents: 0, ids: [] })

export function computeAdjustments(index: AnalyticsIndex, items: ItemAnalytics, grossCents: number, topN: number): AdjustmentAnalytics {
  const months = new Map<MonthKey, AdjustmentBucket>()
  const undated = empty()
  let total = 0
  for (const a of index.adjustments) {
    total += a.amountCents
    const b = a.adjustmentDate === null ? undated : (months.get(monthKey(a.adjustmentDate)) ?? empty())
    b.count += 1
    b.amountCents += a.amountCents
    b.ids.push(a.id)
    if (a.adjustmentDate !== null) months.set(monthKey(a.adjustmentDate), b)
  }
  const byMonth = [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, b]) => ({ ...b, month }))
  const years = new Map<number, AdjustmentBucket>()
  for (const m of byMonth) {
    const y = Number(m.month.slice(0, 4))
    const b = years.get(y) ?? empty()
    b.count += m.count
    b.amountCents += m.amountCents
    b.ids.push(...m.ids)
    years.set(y, b)
  }

  const summaries: ItemAdjustmentSummary[] = items.items
    .filter((i) => i.adjustments.count > 0)
    .map((i) => ({
      itemNumber: i.itemNumber,
      description: i.displayDescription,
      count: i.adjustments.count,
      amountCents: i.adjustments.amountCents,
      itemSpendCents: i.totalSpentCents,
      observedValueRatio: i.totalSpentCents > 0 ? ratio(i.adjustments.amountCents, i.totalSpentCents) : null,
    }))
  const tie = (a: ItemAdjustmentSummary, b: ItemAdjustmentSummary) => (a.itemNumber < b.itemNumber ? -1 : 1)
  const purchased = summaries.filter((s) => s.itemSpendCents > 0)
  const largest = [...index.adjustments].sort((a, b) => b.amountCents - a.amountCents || (a.id < b.id ? -1 : 1))[0]

  return {
    count: index.adjustments.length,
    totalCents: total,
    averageCents: roundCents(ratio(total, index.adjustments.length)),
    largest: largest ? { id: largest.id, itemNumber: largest.itemNumber, amountCents: largest.amountCents, date: largest.adjustmentDate } : null,
    distinctTransactions: new Set(index.adjustments.map((a) => a.transactionId)).size,
    byMonth,
    byYear: [...years.entries()].sort(([a], [b]) => a - b).map(([year, b]) => ({ ...b, year })),
    undated,
    topByCount: [...summaries].sort((a, b) => b.count - a.count || b.amountCents - a.amountCents || tie(a, b)).slice(0, topN),
    topByAmount: [...summaries].sort((a, b) => b.amountCents - a.amountCents || tie(a, b)).slice(0, topN),
    items: summaries,
    observedAdjustmentValueRatio: grossCents > 0 ? ratio(total, grossCents) : null,
    observedAdjustedItemsValueRatio: ratio(
      purchased.reduce((s, p) => s + p.amountCents, 0),
      purchased.reduce((s, p) => s + p.itemSpendCents, 0),
    ),
    purchaseLinkedSavingsRate: purchaseLinkedRate(
      index.adjustments.map((a) => ({ sourcePurchaseId: a.sourcePurchaseId, amount: a.amountCents })),
      index,
      'price adjustment',
    ),
  }
}
