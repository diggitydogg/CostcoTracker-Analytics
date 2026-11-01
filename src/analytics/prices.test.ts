// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from './snapshot'
import { DatasetBuilder } from './test/builder'

describe('price history', () => {
  it('collapses same-day observations into a quantity-weighted daily point', () => {
    const b = new DatasetBuilder()
    const r1 = b.receipt({ date: '2024-01-05' })
    b.item(r1, { itemNumber: '9', unitPriceCents: 1000, quantity: 1 })
    const r2 = b.receipt({ date: '2024-01-05', source: 'online' })
    b.item(r2, { itemNumber: '9', unitPriceCents: 1300, quantity: 2 })
    const h = buildAnalyticsSnapshot(b.build()).items.priceHistories.get('9')!
    expect(h.points).toHaveLength(1)
    expect(h.points[0]).toMatchObject({
      date: '2024-01-05',
      unitPriceCents: 1200, // (1000×1 + 1300×2) / 3
      minCents: 1000,
      maxCents: 1300,
      observations: 2,
      quantity: 3,
      sources: ['online', 'warehouse'],
    })
    expect(h.percentChange).toBeNull() // a single point has no change
  })

  it('never derives a unit price from the line total', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', '7', null, 3, { lineTotalCents: 1000 })
    b.buy('2024-02-01', '7', 350, 2)
    b.buy(null, '7', 400)
    const h = buildAnalyticsSnapshot(b.build()).items.priceHistories.get('7')!
    expect(h.points.map((p) => p.unitPriceCents)).toEqual([350])
    expect(h.unpricedLines).toBe(1)
    expect(h.undatedPricedLines).toBe(1)
  })

  it('computes change, extremes, volatility and the biggest steps', () => {
    const b = new DatasetBuilder()
    const prices = [1000, 1000, 1200, 900, 1100]
    prices.forEach((p, i) => b.buy(`2024-0${i + 1}-01`, '5', p))
    const h = buildAnalyticsSnapshot(b.build()).items.priceHistories.get('5')!
    expect(h.firstCents).toBe(1000)
    expect(h.latestCents).toBe(1100)
    expect(h.absoluteChangeCents).toBe(100)
    expect(h.percentChange).toBeCloseTo(0.1, 12)
    expect(h.minCents).toBe(900)
    expect(h.maxCents).toBe(1200)
    expect(h.meanCents).toBe(1040)
    expect(h.medianCents).toBe(1000)
    // CV = population sd / mean: mean 1040, deviations² = 1600,1600,25600,19600,3600 → sd = √10400.
    expect(h.volatility).toBeCloseTo(Math.sqrt(10400) / 1040, 12)
    expect(h.changeFrequency).toBeCloseTo(3 / 4, 12)
    expect(h.biggestIncrease).toMatchObject({ fromDate: '2024-04-01', toDate: '2024-05-01', changeCents: 200 })
    expect(h.biggestDecrease).toMatchObject({ fromDate: '2024-03-01', toDate: '2024-04-01', changeCents: -300 })
    expect(h.biggestDecrease!.change).toBeCloseTo(-0.25, 12)
  })

  it('withholds volatility with too few points', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', '5', 1000)
    b.buy('2024-02-01', '5', 1500)
    const h = buildAnalyticsSnapshot(b.build()).items.priceHistories.get('5')!
    expect(h.volatility).toBeNull()
    expect(h.percentChange).toBeCloseTo(0.5, 12)
  })
})
