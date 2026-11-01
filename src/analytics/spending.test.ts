// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from './snapshot'
import { DatasetBuilder } from './test/builder'

function dataset() {
  const b = new DatasetBuilder()
  const r1 = b.receipt({ date: '2023-01-10' })
  b.item(r1, { itemNumber: '100', unitPriceCents: 1000, quantity: 2 }) // 2000
  b.item(r1, { itemNumber: '200', unitPriceCents: 333, quantity: 1.5, lineTotalCents: 500 }) // fractional, 500
  const r2 = b.receipt({ date: '2023-03-05', source: 'online' })
  b.item(r2, { itemNumber: '300', unitPriceCents: null, lineTotalCents: 1000 }) // unpriced
  const r3 = b.receipt({ date: null })
  b.item(r3, { itemNumber: '100', unitPriceCents: 1000 }) // undated 1000
  // Two returns in ONE transaction: the whole-transaction total (-9999) must never be summed.
  b.ret({ itemNumber: '100', date: '2023-02-01', amountCents: 1000, transactionId: 't_x', transactionTotalCents: -9999 })
  b.ret({ itemNumber: '200', date: '2023-02-01', amountCents: 250, transactionId: 't_x', transactionTotalCents: -9999 })
  b.ret({ itemNumber: '300', date: '2023-03-20', amountCents: null }) // unknown amount: counted, not estimated
  b.adj({ itemNumber: '100', date: '2023-03-01', amountCents: 300, transactionTotalCents: -300 })
  b.adj({ itemNumber: '100', date: null, amountCents: 50 })
  return b.build()
}

describe('spending', () => {
  it('computes gross, refunds, adjustments and net exactly', () => {
    const s = buildAnalyticsSnapshot(dataset()).spending
    expect(s.lifetime.grossCents).toBe(2000 + 500 + 1000 + 1000)
    expect(s.lifetime.refundCents).toBe(1250)
    expect(s.lifetime.adjustmentCents).toBe(350)
    expect(s.lifetime.netCents).toBe(4500 - 1250 - 350)
    expect(s.lifetime.returnsWithoutAmount.count).toBe(1)
  })

  it('never sums transactionTotalCents', () => {
    const s = buildAnalyticsSnapshot(dataset()).spending
    expect(s.lifetime.refundCents).not.toBe(9999)
    expect(s.lifetime.refundCents).not.toBe(2 * 9999)
    expect(s.lifetime.returnIds).toHaveLength(2)
  })

  it('splits spend by source and keeps provenance', () => {
    const s = buildAnalyticsSnapshot(dataset()).spending
    expect(s.bySource.warehouse.grossCents).toBe(3500)
    expect(s.bySource.online.grossCents).toBe(1000)
    expect(s.bySource.warehouse.receiptIds).toHaveLength(2)
  })

  it('zero-fills months and keeps undated records in a separate bucket that reconciles', () => {
    const s = buildAnalyticsSnapshot(dataset()).spending
    expect(s.monthly.map((m) => m.month)).toEqual(['2023-01', '2023-02', '2023-03'])
    expect(s.monthly.map((m) => [m.grossCents, m.refundCents, m.adjustmentCents])).toEqual([
      [2500, 0, 0],
      [0, 1250, 0],
      [1000, 0, 300],
    ])
    expect(s.undated).toMatchObject({ grossCents: 1000, refundCents: 0, adjustmentCents: 50, netCents: 950 })
    for (const key of ['grossCents', 'refundCents', 'adjustmentCents', 'netCents'] as const) {
      expect(s.monthly.reduce((t, m) => t + m[key], 0) + s.undated[key]).toBe(s.lifetime[key])
      expect(s.yearly.reduce((t, y) => t + y[key], 0) + s.undated[key]).toBe(s.lifetime[key])
    }
  })

  it('averages and medians monthly gross over the purchase span including zero months', () => {
    const s = buildAnalyticsSnapshot(dataset()).spending
    expect(s.monthsInPurchaseSpan).toBe(3)
    expect(s.averageMonthlyGrossCents).toBe(Math.round(3500 / 3))
    expect(s.medianMonthlyGrossCents).toBe(1000)
  })

  it('only compares complete years year-over-year', () => {
    const b = new DatasetBuilder()
    for (const year of [2022, 2023, 2024]) {
      for (let m = 1; m <= 12; m++) {
        if (year === 2024 && m > 6) break
        b.buy(`${year}-${String(m).padStart(2, '0')}-15`, '1', year === 2022 ? 1000 : 1100)
      }
    }
    const s = buildAnalyticsSnapshot(b.build()).spending
    expect(s.yearly.map((y) => [y.year, y.complete, y.monthsInSpan])).toEqual([
      [2022, true, 12],
      [2023, true, 12],
      [2024, false, 6],
    ])
    expect(s.yearOverYear[0]).toMatchObject({ year: 2023, comparable: true })
    expect(s.yearOverYear[0]!.grossChange).toBeCloseTo(0.1, 10)
    expect(s.yearOverYear[1]).toMatchObject({ year: 2024, comparable: false, grossChange: null })
  })

  it('computes rolling 12 months and compares with the prior 12 only when fully covered', () => {
    const b = new DatasetBuilder()
    for (let m = 0; m < 30; m++) {
      const year = 2022 + Math.floor(m / 12)
      b.buy(`${year}-${String((m % 12) + 1).padStart(2, '0')}-10`, '1', m < 18 ? 1000 : 2000)
    }
    const s = buildAnalyticsSnapshot(b.build()).spending
    expect(s.rolling12).toMatchObject({ endMonth: '2024-06', startMonth: '2023-07', grossCents: 12 * 2000 })
    expect(s.rolling12.previous).toEqual({ grossCents: 12 * 1000, netCents: 12 * 1000 })
    expect(s.rolling12.grossChange).toBeCloseTo(1, 10)

    const short = buildAnalyticsSnapshot(dataset()).spending.rolling12
    expect(short.previous).toBeNull()
    expect(short.grossChange).toBeNull()
  })

  it('handles an empty dataset without NaN', () => {
    const s = buildAnalyticsSnapshot(new DatasetBuilder().build()).spending
    expect(s.lifetime.netCents).toBe(0)
    expect(s.monthly).toEqual([])
    expect(s.averageMonthlyGrossCents).toBeNull()
    expect(s.rolling12.endMonth).toBeNull()
  })
})
