// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from '../../analytics'
import { DatasetBuilder, generateDataset } from '../../analytics/test/builder'
import { chainBreaks, changeVs, describeBreak, itemsSummary, lifetimeTotals, periods, queryItems, totalsForRange, type ItemQuery } from './derive'

const snapshot = () => buildAnalyticsSnapshot(generateDataset({ receipts: 150, itemsPerReceipt: 6, returns: 12, adjustments: 6, seed: 21 }))

describe('dashboard period totals', () => {
  it('reconcile exactly with the engine', () => {
    const s = snapshot()
    const [all, last12, fullYear] = periods(s)
    expect(all!.totals).toMatchObject({
      grossCents: s.spending.lifetime.grossCents,
      netCents: s.spending.lifetime.netCents,
      events: s.trips.eventCount,
      averageBasketCents: s.trips.basket.averageCents,
    })
    expect(last12!.id).toBe('last12')
    expect(last12!.totals.grossCents).toBe(s.spending.rolling12.grossCents)
    expect(last12!.totals.netCents).toBe(s.spending.rolling12.netCents)
    expect(last12!.previous?.totals.grossCents).toBe(s.spending.rolling12.previous!.grossCents)
    const year = s.spending.yearly.filter((y) => y.complete).at(-1)!
    expect(fullYear).toMatchObject({ id: 'fullYear', label: String(year.year) })
    expect(fullYear!.totals.grossCents).toBe(year.grossCents)
    expect(fullYear!.totals.refundCents).toBe(year.refundCents)
    expect(fullYear!.totals.adjustmentCents).toBe(year.adjustmentCents)
    expect(fullYear!.totals.netCents).toBe(year.netCents)
    expect(fullYear!.totals.events).toBe(s.trips.byYear.find((y) => y.year === year.year)!.count)
    expect(fullYear!.previous?.totals.grossCents).toBe(s.spending.yearly.find((y) => y.year === year.year - 1)!.grossCents)
  })

  it('sum of every month equals lifetime minus undated', () => {
    const s = snapshot()
    const first = s.spending.monthly[0]!.month
    const last = s.spending.monthly.at(-1)!.month
    const t = totalsForRange(s, first, last)
    const L = lifetimeTotals(s)
    expect(t.grossCents + s.spending.undated.grossCents).toBe(L.grossCents)
    expect(t.netCents + s.spending.undated.netCents).toBe(L.netCents)
    expect(t.events + s.trips.undatedCount).toBe(L.events)
  })

  it('offers no comparison when the earlier period is not inside the data', () => {
    const b = new DatasetBuilder()
    b.buy('2025-03-01', 'A', 1000)
    b.buy('2025-06-01', 'A', 1100)
    const ps = periods(buildAnalyticsSnapshot(b.build()))
    expect(ps.map((p) => p.id)).toEqual(['all', 'last12']) // no complete year
    expect(ps[1]!.previous).toBeNull()
  })

  it('handles an empty dataset', () => {
    const ps = periods(buildAnalyticsSnapshot(new DatasetBuilder().build()))
    expect(ps.map((p) => p.id)).toEqual(['all'])
    expect(ps[0]!.totals.averageBasketCents).toBeNull()
    expect(changeVs(100, 0)).toBeNull()
    expect(changeVs(110, 100)).toBeCloseTo(0.1, 12)
    expect(changeVs(null, 100)).toBeNull()
  })
})

describe('item queries', () => {
  const base: ItemQuery = { search: '', filter: 'all', categoryId: 'all', sort: 'spend', descending: true }
  it('searches description variants and item numbers, all terms required', () => {
    const s = snapshot()
    const byNumber = queryItems(s.items.items, { ...base, search: '1000002' })
    expect(byNumber.map((i) => i.itemNumber)).toContain('1000002')
    const towels = queryItems(s.items.items, { ...base, search: 'paper  towels' })
    expect(towels.length).toBeGreaterThan(0)
    expect(towels.every((i) => i.descriptions.some((d) => d.includes('PAPER TOWELS')))).toBe(true)
    expect(queryItems(s.items.items, { ...base, search: 'towels zzz-no-match' })).toEqual([])
  })

  it('filters by cohort, recent and category', () => {
    const s = snapshot()
    for (const c of ['staple', 'occasional', 'one-and-done', 'dormant-staple'] as const) {
      expect(queryItems(s.items.items, { ...base, filter: c }).map((i) => i.itemNumber).sort()).toEqual([...s.items.cohorts[c]].sort())
    }
    expect(queryItems(s.items.items, { ...base, filter: 'recent' }).length).toBe(s.items.cohorts.recent.length)
    const grocery = queryItems(s.items.items, { ...base, categoryId: 'grocery' })
    expect(grocery.every((i) => i.category.categoryId === 'grocery')).toBe(true)
  })

  it('sorts both ways with missing values always last', () => {
    const s = snapshot()
    const desc = queryItems(s.items.items, { ...base, sort: 'latestPrice', descending: true })
    const asc = queryItems(s.items.items, { ...base, sort: 'latestPrice', descending: false })
    for (const list of [desc, asc]) {
      const firstNull = list.findIndex((i) => i.latestUnitPriceCents === null)
      if (firstNull >= 0) expect(list.slice(firstNull).every((i) => i.latestUnitPriceCents === null)).toBe(true)
    }
    const priced = (l: typeof desc) => l.filter((i) => i.latestUnitPriceCents !== null).map((i) => i.latestUnitPriceCents!)
    expect(priced(desc)).toEqual([...priced(desc)].sort((a, b) => b - a))
    expect(priced(asc)).toEqual([...priced(asc)].sort((a, b) => a - b))
    const spend = queryItems(s.items.items, base).map((i) => i.totalSpentCents)
    expect(spend).toEqual([...spend].sort((a, b) => b - a))
  })
})

describe('item count wording', () => {
  it('names purchased and returns/adjustments-only items when they differ', () => {
    expect(itemsSummary({ all: 693, purchased: 691, returnsOrAdjustmentsOnly: 2 })).toBe(
      '693 items: 691 bought in this data and 2 seen only in returns or price adjustments.',
    )
    expect(itemsSummary({ all: 1, purchased: 1, returnsOrAdjustmentsOnly: 0 })).toBe('1 item, all bought in this data.')
  })
})

describe('price index chain breaks', () => {
  it('finds where each chain breaks and why', () => {
    const b = new DatasetBuilder()
    for (const i of ['A', 'B', 'C', 'D', 'E']) b.buy('2023-03-01', i, 1000)
    b.buy('2024-03-01', 'F', 1000)
    b.buy('2025-03-01', 'F', 1100)
    const s = buildAnalyticsSnapshot(b.build())
    const breaks = chainBreaks(s.inflation.yearly)
    expect(breaks.simple).toEqual({ linkIndex: 0, from: '2023', to: '2024', reason: 'no-comparable-items' })
    expect(breaks.weighted).toEqual(breaks.simple)
    expect(describeBreak(breaks.simple!)).toBe('no item was bought with a recorded price in both 2023 and 2024')
  })

  it('distinguishes a weighted-only break and an unbroken chain', () => {
    const b = new DatasetBuilder()
    b.buy('2023-03-01', 'A', 1000)
    b.buy('2024-03-01', 'A', 1100)
    const breaks = chainBreaks(buildAnalyticsSnapshot(b.build()).inflation.yearly)
    expect(breaks.simple).toBeNull()
    expect(breaks.weighted).toMatchObject({ linkIndex: 0, reason: 'too-few-for-weighted' })
    const ok = new DatasetBuilder()
    for (const i of ['A', 'B', 'C', 'D', 'E']) {
      ok.buy('2023-03-01', i, 1000)
      ok.buy('2024-03-01', i, 1050)
    }
    expect(chainBreaks(buildAnalyticsSnapshot(ok.build()).inflation.yearly)).toEqual({ weighted: null, simple: null })
  })
})
