/**
 * Pure, tested presentation helpers over an AnalyticsSnapshot. They never
 * compute a new metric: period totals are sums of the engine's own monthly
 * buckets (so they reconcile with it exactly), and item lists are filtered and
 * sorted views of the engine's per-item statistics.
 */
import type { AnalyticsSnapshot, ItemCohort, ItemStats } from '../../analytics'
import { addMonths, type MonthKey } from '../../analytics/dates'
import { relativeChange } from '../../analytics/stats'

export type PeriodId = 'all' | 'last12' | 'fullYear'

export type PeriodTotals = {
  grossCents: number
  refundCents: number
  adjustmentCents: number
  netCents: number
  /** Purchase events (receipts/orders) in the period, with or without exported lines. */
  events: number
  /** Events with at least one exported line (the basket population). */
  eventsWithBasket: number
  averageBasketCents: number | null
  receiptIds: string[]
  returnIds: string[]
  adjustmentIds: string[]
}

export type Period = {
  id: PeriodId
  label: string
  /** Inclusive month range; null for all time. */
  range: { start: MonthKey; end: MonthKey } | null
  totals: PeriodTotals
  /** The preceding period of the same length, only when it lies fully inside the data. */
  previous: { label: string; totals: PeriodTotals } | null
}

export function totalsForRange(s: AnalyticsSnapshot, start: MonthKey, end: MonthKey): PeriodTotals {
  const t: PeriodTotals = {
    grossCents: 0,
    refundCents: 0,
    adjustmentCents: 0,
    netCents: 0,
    events: 0,
    eventsWithBasket: 0,
    averageBasketCents: null,
    receiptIds: [],
    returnIds: [],
    adjustmentIds: [],
  }
  for (const m of s.spending.monthly) {
    if (m.month < start || m.month > end) continue
    t.grossCents += m.grossCents
    t.refundCents += m.refundCents
    t.adjustmentCents += m.adjustmentCents
    t.netCents += m.netCents
    t.receiptIds.push(...m.receiptIds)
    t.returnIds.push(...m.returnIds)
    t.adjustmentIds.push(...m.adjustmentIds)
  }
  for (const m of s.trips.byMonth) if (m.month >= start && m.month <= end) t.events += m.count
  t.eventsWithBasket = t.receiptIds.length
  t.averageBasketCents = t.eventsWithBasket > 0 ? Math.round(t.grossCents / t.eventsWithBasket) : null
  return t
}

export function lifetimeTotals(s: AnalyticsSnapshot): PeriodTotals {
  const L = s.spending.lifetime
  return {
    grossCents: L.grossCents,
    refundCents: L.refundCents,
    adjustmentCents: L.adjustmentCents,
    netCents: L.netCents,
    events: s.trips.eventCount,
    eventsWithBasket: s.trips.basket.eventsWithBasket,
    averageBasketCents: s.trips.basket.averageCents,
    receiptIds: L.receiptIds,
    returnIds: L.returnIds,
    adjustmentIds: L.adjustmentIds,
  }
}

const yearRange = (y: number) => ({ start: `${y}-01`, end: `${y}-12` })

/** The periods the overview offers, with comparisons only where comparable. */
export function periods(s: AnalyticsSnapshot): Period[] {
  const out: Period[] = [{ id: 'all', label: 'All time', range: null, totals: lifetimeTotals(s), previous: null }]
  const r = s.spending.rolling12
  if (r.startMonth && r.endMonth && s.spending.monthly.length > 0) {
    const prevStart = addMonths(r.startMonth, -12)
    const prevEnd = addMonths(r.endMonth, -12)
    out.push({
      id: 'last12',
      label: 'Last 12 months',
      range: { start: r.startMonth, end: r.endMonth },
      totals: totalsForRange(s, r.startMonth, r.endMonth),
      previous: r.previous ? { label: 'previous 12 months', totals: totalsForRange(s, prevStart, prevEnd) } : null,
    })
  }
  const complete = s.spending.yearly.filter((y) => y.complete)
  const latest = complete[complete.length - 1]
  if (latest) {
    const prior = complete.find((y) => y.year === latest.year - 1)
    const range = yearRange(latest.year)
    out.push({
      id: 'fullYear',
      label: String(latest.year),
      range,
      totals: totalsForRange(s, range.start, range.end),
      previous: prior ? { label: String(prior.year), totals: totalsForRange(s, `${prior.year}-01`, `${prior.year}-12`) } : null,
    })
  }
  return out
}

export function changeVs(current: number | null, previous: number | null | undefined): number | null {
  if (current === null || previous === null || previous === undefined) return null
  return relativeChange(previous, current)
}

// ---------------------------------------------------------------- items

export type ItemFilter = ItemCohort | 'recent' | 'all'
export type ItemSortKey =
  | 'description'
  | 'spend'
  | 'quantity'
  | 'events'
  | 'lastPurchase'
  | 'latestPrice'
  | 'priceChange'
  | 'cohort'

export const COHORT_LABEL: Record<ItemCohort, string> = {
  staple: 'Staple',
  'dormant-staple': 'Dormant staple',
  occasional: 'Occasional',
  'one-and-done': 'One-and-done',
  'not-purchased': 'Not bought in data',
}

const COHORT_ORDER: ItemCohort[] = ['staple', 'dormant-staple', 'occasional', 'one-and-done', 'not-purchased']

const sortValue: Record<ItemSortKey, (i: ItemStats) => number | string | null> = {
  description: (i) => i.displayDescription,
  spend: (i) => i.totalSpentCents,
  quantity: (i) => i.totalQuantity,
  events: (i) => i.purchaseEvents,
  lastPurchase: (i) => i.lastPurchaseDate,
  latestPrice: (i) => i.latestUnitPriceCents,
  priceChange: (i) => i.priceChange,
  cohort: (i) => COHORT_ORDER.indexOf(i.cohort),
}

export type ItemQuery = { search: string; filter: ItemFilter; categoryId: string | 'all'; sort: ItemSortKey; descending: boolean }

/** Filters by search text (any description variant or item number), cohort and category; missing values always sort last. */
export function queryItems(items: readonly ItemStats[], q: ItemQuery): ItemStats[] {
  const needle = q.search.trim().toUpperCase()
  const terms = needle.split(/\s+/).filter(Boolean)
  const matches = items.filter((i) => {
    if (q.filter === 'recent' ? !i.recent : q.filter !== 'all' && i.cohort !== q.filter) return false
    if (q.categoryId !== 'all' && i.category.categoryId !== q.categoryId) return false
    if (terms.length === 0) return true
    const hay = `${i.itemNumber} ${i.descriptions.join(' ')}`.toUpperCase()
    return terms.every((t) => hay.includes(t))
  })
  const key = sortValue[q.sort]
  const dir = q.descending ? -1 : 1
  return matches.sort((a, b) => {
    const va = key(a)
    const vb = key(b)
    if (va === null && vb === null) return a.itemNumber < b.itemNumber ? -1 : 1
    if (va === null) return 1
    if (vb === null) return -1
    const c = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number)
    return c !== 0 ? dir * c : a.itemNumber < b.itemNumber ? -1 : 1
  })
}
