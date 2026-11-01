// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from './snapshot'
import { DatasetBuilder } from './test/builder'

/** Five matched items across 2022 → 2023, plus a one-off and a pack-size outlier. */
function basket() {
  const b = new DatasetBuilder()
  const y22: [string, number, number][] = [['A', 100, 1], ['B', 200, 1], ['C', 300, 1], ['D', 400, 1], ['E', 500, 1], ['G', 100, 1]]
  const y23: [string, number, number][] = [['A', 110, 1], ['B', 220, 2], ['C', 300, 1], ['D', 380, 1], ['E', 550, 1], ['G', 1000, 1], ['F', 999, 1]]
  y22.forEach(([item, price, qty], i) => b.buy(`2022-0${i + 1}-15`, item, price, qty))
  y23.forEach(([item, price, qty], i) => b.buy(`2023-0${i + 1}-15`, item, price, qty))
  return b.build()
}

describe('personal inflation', () => {
  it('computes the simple matched-item (Jevons) link exactly', () => {
    const link = buildAnalyticsSnapshot(basket()).inflation.yearly.links[0]!
    expect(link).toMatchObject({ from: '2022', to: '2023', matchedItems: 5, outliersExcluded: 1 })
    const jevons = Math.pow(1.1 * 1.1 * 1.0 * 0.95 * 1.1, 1 / 5)
    expect(link.simpleRelative).toBeCloseTo(jevons, 12)
    expect(link.simpleChange).toBeCloseTo(jevons - 1, 12)
    expect(link.items.map((i) => i.itemNumber)).toEqual(['A', 'B', 'C', 'D', 'E']) // F one-off and G outlier excluded
  })

  it('computes the weighted personal-basket (Törnqvist) link exactly', () => {
    const link = buildAnalyticsSnapshot(basket()).inflation.yearly.links[0]!
    const s22 = [100, 200, 300, 400, 500]
    const s23 = [110, 440, 300, 380, 550]
    const r = [1.1, 1.1, 1.0, 0.95, 1.1]
    const sum22 = s22.reduce((a, b) => a + b)
    const sum23 = s23.reduce((a, b) => a + b)
    const w = s22.map((_, i) => (s22[i]! / sum22 + s23[i]! / sum23) / 2)
    const expected = Math.exp(w.reduce((acc, wi, i) => acc + wi * Math.log(r[i]!), 0))
    expect(link.weightedRelative).toBeCloseTo(expected, 12)
    expect(link.items.reduce((s, i) => s + i.weight!, 0)).toBeCloseTo(1, 12)
  })

  it('reports coverage and reliability', () => {
    const inf = buildAnalyticsSnapshot(basket()).inflation
    const link = inf.yearly.links[0]!
    expect(link.spendCoverage).toBeCloseTo((1500 + 1780) / (1600 + 3779), 12)
    expect(link.reliable).toBe(true)
    expect(inf.summary.sufficientData).toBe(true)
    expect(inf.summary.firstYear).toBe('2022')
    expect(inf.summary.cumulativeSimpleChange).toBeCloseTo(link.simpleChange!, 12)
    expect(inf.summary.annualizedSimpleChange).toBeCloseTo(link.simpleChange!, 12)
    expect(inf.yearly.periods[1]!.simpleIndex).toBeCloseTo(100 * link.simpleRelative!, 10)
    expect(inf.eligibleItems).toBe(6) // A–E plus G (priced in both years, even if excluded as an outlier)
  })

  it('refuses to call sparse data reliable', () => {
    const b = new DatasetBuilder()
    b.buy('2022-03-01', 'A', 100)
    b.buy('2022-03-01', 'B', 200)
    b.buy('2023-03-01', 'A', 120)
    b.buy('2023-03-01', 'B', 210)
    const inf = buildAnalyticsSnapshot(b.build()).inflation
    const link = inf.yearly.links[0]!
    expect(link.matchedItems).toBe(2)
    expect(link.simpleRelative).toBeCloseTo(Math.sqrt(1.2 * 1.05), 12)
    expect(link.weightedRelative).toBeNull()
    expect(link.reliable).toBe(false)
    expect(inf.summary.sufficientData).toBe(false)
    expect(inf.summary.reasons.join(' ')).toMatch(/Only 2 item/)
  })

  it('breaks the chain instead of guessing when a link has no matched items', () => {
    const b = new DatasetBuilder()
    b.buy('2021-01-01', 'A', 100)
    b.buy('2022-01-01', 'B', 100)
    b.buy('2023-01-01', 'A', 110)
    const inf = buildAnalyticsSnapshot(b.build()).inflation
    expect(inf.yearly.periods.map((p) => p.simpleIndex)).toEqual([100, null, null])
    expect(inf.summary.cumulativeSimpleChange).toBeNull()
  })

  it('annualizes over calendar years elapsed when a year is skipped', () => {
    const b = new DatasetBuilder()
    for (const item of ['A', 'B', 'C', 'D', 'E']) {
      b.buy('2021-05-01', item, 1000)
      b.buy('2023-05-01', item, 1210)
    }
    const s = buildAnalyticsSnapshot(b.build()).inflation.summary
    expect(s.cumulativeSimpleChange).toBeCloseTo(0.21, 12)
    expect(s.annualizedSimpleChange).toBeCloseTo(0.1, 12)
    expect(s.annualizedWeightedChange).toBeCloseTo(0.1, 12)
  })

  it('supports monthly granularity', () => {
    const b = new DatasetBuilder()
    for (const item of ['A', 'B', 'C', 'D', 'E']) {
      b.buy('2024-01-10', item, 500)
      b.buy('2024-02-10', item, 550)
    }
    const monthly = buildAnalyticsSnapshot(b.build()).inflation.monthly
    expect(monthly.links[0]).toMatchObject({ from: '2024-01', to: '2024-02', matchedItems: 5, reliable: true })
    expect(monthly.links[0]!.simpleRelative).toBeCloseTo(1.1, 12)
  })

  it('ignores unpriced and undated lines', () => {
    const b = new DatasetBuilder()
    b.buy('2022-01-01', 'A', null, 1, { lineTotalCents: 100 })
    b.buy(null, 'A', 100)
    b.buy('2023-01-01', 'A', 110)
    const inf = buildAnalyticsSnapshot(b.build()).inflation
    expect(inf.yearly.links[0]!.matchedItems).toBe(0)
    expect(inf.eligibleItems).toBe(0)
  })
})
