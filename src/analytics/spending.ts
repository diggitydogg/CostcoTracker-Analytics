/**
 * Overall spending.
 *
 * Definitions (all integer cents, pre-tax — the export carries no tax):
 * - gross purchase spend = Σ items.lineTotalCents. A line total is the
 *   recorded net amount for the line after Costco instant savings.
 * - refunds = Σ returns.merchandiseAmountCents over returns that record it.
 *   Returns without a merchandise amount are counted separately and never
 *   estimated. `transactionTotalCents` is NOT used: it is the whole
 *   transaction (other lines, tax) repeated on every row of the transaction.
 * - price adjustments = Σ priceAdjustments.amountCents (recorded savings).
 *   Again never transactionTotalCents.
 * - net spend = gross − refunds − price adjustments (exact identity).
 *
 * Time attribution: purchases by receipt purchaseDate, refunds by returnDate,
 * adjustments by adjustmentDate. Records without a date go to an explicit
 * "undated" bucket, so Σ monthly + undated = lifetime for every measure.
 */
import { addMonths, monthKey, monthRange, type MonthKey } from './dates'
import type { AnalyticsIndex } from './model'
import { mean, median, relativeChange, roundCents } from './stats'

export type SpendBucket = {
  grossCents: number
  refundCents: number
  adjustmentCents: number
  netCents: number
  /** Provenance: receipts whose lines make up grossCents. */
  receiptIds: string[]
  /** Returns contributing refundCents (only those with a recorded amount). */
  returnIds: string[]
  adjustmentIds: string[]
}

export type MonthlySpend = SpendBucket & { month: MonthKey }
export type YearlySpend = SpendBucket & {
  year: number
  /** Months of this year inside the dataset's dated span (≤ 12). */
  monthsInSpan: number
  /** True when every month of the year lies inside the dated span. */
  complete: boolean
}

export type YearOverYear = {
  year: number
  previousYear: number
  grossChange: number | null
  netChange: number | null
  /** Year-over-year change is only computed between two complete years. */
  comparable: boolean
}

export type SpendingAnalytics = {
  lifetime: SpendBucket & {
    /** Returns with no recorded merchandise amount (not included in refunds). */
    returnsWithoutAmount: { count: number; ids: string[] }
  }
  bySource: Record<'warehouse' | 'online' | 'synthetic', { grossCents: number; receiptIds: string[] }>
  monthly: MonthlySpend[]
  yearly: YearlySpend[]
  undated: SpendBucket
  yearOverYear: YearOverYear[]
  rolling12: {
    /** Window end (the as-of month) and start, inclusive. */
    endMonth: MonthKey | null
    startMonth: MonthKey | null
    grossCents: number
    netCents: number
    previous: { grossCents: number; netCents: number } | null
    /** Change vs the 12 months before, only when that whole window is inside the data span. */
    grossChange: number | null
    netChange: number | null
  }
  /** Purchase span: first to last month with a dated purchase. */
  averageMonthlyGrossCents: number | null
  medianMonthlyGrossCents: number | null
  monthsInPurchaseSpan: number
}

function emptyBucket(): SpendBucket {
  return { grossCents: 0, refundCents: 0, adjustmentCents: 0, netCents: 0, receiptIds: [], returnIds: [], adjustmentIds: [] }
}

function finish<T extends SpendBucket>(bucket: T): T {
  bucket.netCents = bucket.grossCents - bucket.refundCents - bucket.adjustmentCents
  return bucket
}

export function computeSpending(index: AnalyticsIndex): SpendingAnalytics {
  const months = new Map<MonthKey, SpendBucket>()
  const undated = emptyBucket()
  const lifetime = emptyBucket()
  const bucketFor = (month: MonthKey | null) => {
    if (month === null) return undated
    let b = months.get(month)
    if (!b) months.set(month, (b = emptyBucket()))
    return b
  }

  const bySource: SpendingAnalytics['bySource'] = {
    warehouse: { grossCents: 0, receiptIds: [] },
    online: { grossCents: 0, receiptIds: [] },
    synthetic: { grossCents: 0, receiptIds: [] },
  }
  for (const event of index.events) {
    if (event.basketCents === null) continue
    const b = bucketFor(event.month)
    b.grossCents += event.basketCents
    b.receiptIds.push(event.id)
    lifetime.grossCents += event.basketCents
    lifetime.receiptIds.push(event.id)
    bySource[event.sourceType].grossCents += event.basketCents
    bySource[event.sourceType].receiptIds.push(event.id)
  }

  const returnsWithoutAmount = { count: 0, ids: [] as string[] }
  for (const r of index.returns) {
    if (r.merchandiseAmountCents === null) {
      returnsWithoutAmount.count += 1
      returnsWithoutAmount.ids.push(r.id)
      continue
    }
    const b = bucketFor(r.returnDate === null ? null : monthKey(r.returnDate))
    b.refundCents += r.merchandiseAmountCents
    b.returnIds.push(r.id)
    lifetime.refundCents += r.merchandiseAmountCents
    lifetime.returnIds.push(r.id)
  }

  for (const a of index.adjustments) {
    const b = bucketFor(a.adjustmentDate === null ? null : monthKey(a.adjustmentDate))
    b.adjustmentCents += a.amountCents
    b.adjustmentIds.push(a.id)
    lifetime.adjustmentCents += a.amountCents
    lifetime.adjustmentIds.push(a.id)
  }

  // Monthly series over the full dated span (purchases, returns and adjustments), zero-filled.
  const keys = [...months.keys()].sort()
  const monthly: MonthlySpend[] =
    keys.length === 0
      ? []
      : monthRange(keys[0]!, keys[keys.length - 1]!).map((month) => finish({ ...(months.get(month) ?? emptyBucket()), month }))

  // Yearly.
  const spanStart = keys[0] ?? null
  const yearly: YearlySpend[] = []
  for (const m of monthly) {
    const year = Number(m.month.slice(0, 4))
    let y = yearly[yearly.length - 1]
    if (!y || y.year !== year) {
      y = { ...emptyBucket(), year, monthsInSpan: 0, complete: false }
      yearly.push(y)
    }
    y.grossCents += m.grossCents
    y.refundCents += m.refundCents
    y.adjustmentCents += m.adjustmentCents
    y.receiptIds.push(...m.receiptIds)
    y.returnIds.push(...m.returnIds)
    y.adjustmentIds.push(...m.adjustmentIds)
    y.monthsInSpan += 1
  }
  for (const y of yearly) {
    finish(y)
    y.complete = y.monthsInSpan === 12
  }

  const yearOverYear: YearOverYear[] = []
  for (let i = 1; i < yearly.length; i++) {
    const prev = yearly[i - 1]!
    const cur = yearly[i]!
    const comparable = prev.complete && cur.complete && cur.year === prev.year + 1
    yearOverYear.push({
      year: cur.year,
      previousYear: prev.year,
      comparable,
      grossChange: comparable ? relativeChange(prev.grossCents, cur.grossCents) : null,
      netChange: comparable ? relativeChange(prev.netCents, cur.netCents) : null,
    })
  }

  // Rolling 12 months ending at the as-of month.
  const endMonth = index.asOf === null ? null : monthKey(index.asOf)
  const windowSum = (start: MonthKey, end: MonthKey) => {
    let gross = 0
    let net = 0
    for (const m of monthly) {
      if (m.month >= start && m.month <= end) {
        gross += m.grossCents
        net += m.netCents
      }
    }
    return { grossCents: gross, netCents: net }
  }
  let rolling12: SpendingAnalytics['rolling12'] = {
    endMonth: null,
    startMonth: null,
    grossCents: 0,
    netCents: 0,
    previous: null,
    grossChange: null,
    netChange: null,
  }
  if (endMonth !== null) {
    const startMonth = addMonths(endMonth, -11)
    const current = windowSum(startMonth, endMonth)
    const prevStart = addMonths(startMonth, -12)
    const previous = spanStart !== null && spanStart <= prevStart ? windowSum(prevStart, addMonths(startMonth, -1)) : null
    rolling12 = {
      endMonth,
      startMonth,
      ...current,
      previous,
      grossChange: previous ? relativeChange(previous.grossCents, current.grossCents) : null,
      netChange: previous ? relativeChange(previous.netCents, current.netCents) : null,
    }
  }

  // Average / median monthly gross over the purchase span (first to last dated purchase month), zero months included.
  const purchaseMonths = index.events.filter((e) => e.month !== null && e.basketCents !== null).map((e) => e.month!)
  let purchaseSpan: MonthlySpend[] = []
  if (purchaseMonths.length > 0) {
    const first = purchaseMonths.reduce((a, b) => (a < b ? a : b))
    const last = purchaseMonths.reduce((a, b) => (a > b ? a : b))
    purchaseSpan = monthly.filter((m) => m.month >= first && m.month <= last)
  }

  return {
    lifetime: { ...finish(lifetime), returnsWithoutAmount },
    bySource,
    monthly,
    yearly,
    undated: finish(undated),
    yearOverYear,
    rolling12,
    averageMonthlyGrossCents: roundCents(mean(purchaseSpan.map((m) => m.grossCents))),
    medianMonthlyGrossCents: roundCents(median(purchaseSpan.map((m) => m.grossCents))),
    monthsInPurchaseSpan: purchaseSpan.length,
  }
}
