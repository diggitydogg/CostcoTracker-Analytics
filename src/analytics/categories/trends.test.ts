// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from '../snapshot'
import { generateDataset } from '../test/builder'
import { categoryTrends } from './trends'

describe('category trends', () => {
  it('reconciles each category with its lifetime spend and each year with gross', () => {
    const s = buildAnalyticsSnapshot(generateDataset({ receipts: 150, itemsPerReceipt: 6, returns: 5, adjustments: 3, seed: 3 }))
    const t = categoryTrends(s.index, s.items)
    expect(t.years.length).toBeGreaterThan(2)
    for (const c of s.categories.categories) {
      const row = t.rows.find((r) => r.categoryId === c.categoryId)!
      expect(row.byYear.reduce((a, y) => a + y.spendCents, 0) + row.undatedCents).toBe(c.spendCents)
    }
    t.years.forEach((year, i) => {
      expect(t.rows.reduce((a, r) => a + r.byYear[i]!.spendCents, 0)).toBe(t.yearTotals[i])
      expect(t.yearTotals[i]).toBe(s.spending.yearly.find((y) => y.year === year)!.grossCents)
      const shares = t.rows.map((r) => r.byYear[i]!.share ?? 0)
      expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    })
  })

  it('follows category overrides', () => {
    const data = generateDataset({ receipts: 40, itemsPerReceipt: 4, returns: 0, adjustments: 0, seed: 5 })
    const base = buildAnalyticsSnapshot(data)
    const item = base.items.topBySpend[0]!
    const s = buildAnalyticsSnapshot(data, { categoryOverrides: { [item]: { categoryId: 'automotive' } } })
    const auto = categoryTrends(s.index, s.items).rows.find((r) => r.categoryId === 'automotive')!
    expect(auto.byYear.reduce((a, y) => a + y.spendCents, 0) + auto.undatedCents).toBeGreaterThanOrEqual(s.items.byItemNumber.get(item)!.totalSpentCents)
  })
})
