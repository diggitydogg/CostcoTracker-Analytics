// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from './snapshot'
import { DatasetBuilder } from './test/builder'

describe('items', () => {
  it('aggregates quantity, spend and recorded unit prices (fractional quantities)', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', '42', 300, 1.37, { lineTotalCents: 411, description: '  SYNTHETIC   PRODUCE ' })
    b.buy('2024-02-01', '42', 320, 2)
    b.buy('2024-03-01', '42', null, 3, { lineTotalCents: 1000 })
    const item = buildAnalyticsSnapshot(b.build()).items.byItemNumber.get('42')!
    expect(item.totalQuantity).toBe(6.37)
    expect(item.totalSpentCents).toBe(411 + 640 + 1000)
    expect(item.pricedLineCount).toBe(2)
    expect(item.averageUnitPriceCents).toBe(Math.round((300 * 1.37 + 320 * 2) / 3.37))
    expect(item.firstUnitPriceCents).toBe(300)
    expect(item.latestUnitPriceCents).toBe(320)
    expect(item.priceChange).toBeCloseTo(20 / 300, 12)
    expect(item.purchaseEvents).toBe(3)
    expect(item.cadence).toEqual({ intervals: 2, meanDays: (31 + 29) / 2, medianDays: 30 })
    expect(item.descriptions).toEqual(['SYNTHETIC ITEM 42', 'SYNTHETIC PRODUCE'])
  })

  it('classifies cohorts deterministically', () => {
    const b = new DatasetBuilder()
    // Staple: 5 purchases over 5 months, still bought recently.
    for (const m of ['01', '02', '03', '04', '05']) b.buy(`2024-${m}-10`, 'staple', 500)
    // Dormant staple: 4 purchases in 2022, nothing since.
    for (const m of ['01', '03', '05', '07']) b.buy(`2022-${m}-10`, 'dormant', 500)
    // Occasional: two purchases.
    b.buy('2023-06-01', 'occasional', 500)
    b.buy('2024-05-01', 'occasional', 500)
    // One and done.
    b.buy('2023-01-01', 'once', 500)
    // Frequent but within one month only: not a staple.
    for (const d of ['01', '05', '09', '13']) b.buy(`2024-04-${d}`, 'burst', 500)
    // Returned but never bought in the data.
    b.ret({ itemNumber: 'ghost', date: '2024-05-01' })
    const s = buildAnalyticsSnapshot(b.build(), { asOf: '2024-05-20' })
    expect(s.items.cohorts).toMatchObject({
      staple: ['staple'],
      'dormant-staple': ['dormant'],
      occasional: ['burst', 'occasional'],
      'one-and-done': ['once'],
      'not-purchased': ['ghost'],
    })
    expect(s.items.cohorts.recent).toEqual(['occasional', 'staple'])
    expect(s.items.byItemNumber.get('dormant')!.daysSinceLastPurchase).toBe(680)
    // 6 item numbers: 5 purchased + 'ghost', seen only in a return/adjustment.
    expect(s.items.itemCounts).toEqual({ all: 6, purchased: 5, returnsOrAdjustmentsOnly: 1 })
    expect(s.items.items).toHaveLength(s.items.itemCounts.all)
  })

  it('lets thresholds be tuned in one place', () => {
    const b = new DatasetBuilder()
    for (const m of ['01', '02']) b.buy(`2024-${m}-10`, 'x', 500)
    const s = buildAnalyticsSnapshot(b.build(), { thresholds: { stapleMinEvents: 2, stapleMinDistinctMonths: 2 } })
    expect(s.items.byItemNumber.get('x')!.cohort).toBe('staple')
  })

  it('attaches returns and adjustments by item number', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', '1', 1000, 4)
    b.ret({ itemNumber: '1', quantity: 1, amountCents: 1000 })
    b.ret({ itemNumber: '1', quantity: 0.5, amountCents: null })
    b.adj({ itemNumber: '1', amountCents: 150 })
    const item = buildAnalyticsSnapshot(b.build()).items.byItemNumber.get('1')!
    expect(item.returns).toMatchObject({ count: 2, quantity: 1.5, amountCents: 1000, withoutAmount: 1 })
    expect(item.adjustments).toMatchObject({ count: 1, amountCents: 150 })
  })
})
