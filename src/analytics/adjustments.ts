/**
 * Price adjustments (recorded refunds of a price difference — not price-match
 * opportunities). Amounts are adjustment.amountCents (positive savings);
 * transactionTotalCents is never summed.
 *
 * Savings rates:
 * - overall = Σ adjustment amounts ÷ gross purchase spend;
 * - adjusted items = Σ adjustments on items purchased in the data ÷ spend on
 *   those items (how much was recovered where adjustments happened).
 */
import { monthKey, type MonthKey } from './dates'
import type { ItemAnalytics } from './items'
import type { AnalyticsIndex } from './model'
import { ratio, roundCents } from './stats'

export type AdjustmentBucket = { count: number; amountCents: number; ids: string[] }

export type ItemAdjustmentSummary = {
  itemNumber: string
  description: string
  count: number
  amountCents: number
  itemSpendCents: number
  /** amount recovered ÷ item spend in the data; null if not purchased in the data. */
  savingsRate: number | null
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
  overallSavingsRate: number | null
  adjustedItemsSavingsRate: number | null
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
      savingsRate: i.totalSpentCents > 0 ? ratio(i.adjustments.amountCents, i.totalSpentCents) : null,
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
    overallSavingsRate: grossCents > 0 ? ratio(total, grossCents) : null,
    adjustedItemsSavingsRate: ratio(
      purchased.reduce((s, p) => s + p.amountCents, 0),
      purchased.reduce((s, p) => s + p.itemSpendCents, 0),
    ),
  }
}
