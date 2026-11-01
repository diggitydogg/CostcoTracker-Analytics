// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from './snapshot'
import { DatasetBuilder } from './test/builder'

function data() {
  const b = new DatasetBuilder()
  b.buy('2024-01-01', 'TV', 50000, 1)
  b.buy('2024-01-01', 'SOCKS', 1000, 4)
  // One return transaction with two rows: its -60000 total must never be summed.
  b.ret({ itemNumber: 'TV', date: '2024-02-01', quantity: 1, amountCents: 50000, transactionId: 't_1', transactionTotalCents: -60000 })
  b.ret({ itemNumber: 'SOCKS', date: '2024-02-01', quantity: 2, amountCents: 2000, transactionId: 't_1', transactionTotalCents: -60000 })
  b.ret({ itemNumber: 'SOCKS', date: '2024-03-01', quantity: 1, amountCents: null })
  b.ret({ itemNumber: 'OLD', date: null, quantity: 1, amountCents: 700 }) // bought before the data
  b.adj({ itemNumber: 'TV', date: '2024-01-20', amountCents: 4000, transactionTotalCents: -4000 })
  b.adj({ itemNumber: 'TV', date: '2024-02-05', amountCents: 1000 })
  b.adj({ itemNumber: 'SOCKS', date: null, amountCents: 200 })
  return b.build()
}

describe('returns', () => {
  it('totals counts, quantities and recorded amounts without double counting', () => {
    const r = buildAnalyticsSnapshot(data()).returns
    expect(r.count).toBe(4)
    expect(r.quantity).toBe(5)
    expect(r.amountCents).toBe(50000 + 2000 + 700)
    expect(r.withoutAmount.count).toBe(1)
    expect(r.distinctTransactions).toBe(3)
    expect(r.byMonth.map((m) => [m.month, m.count, m.amountCents])).toEqual([
      ['2024-02', 2, 52000],
      ['2024-03', 1, 0],
    ])
    expect(r.undated).toMatchObject({ count: 1, amountCents: 700 })
  })

  it('ranks items and computes defensible return rates', () => {
    const s = buildAnalyticsSnapshot(data())
    const r = s.returns
    expect(r.topByCount.map((i) => i.itemNumber)).toEqual(['SOCKS', 'OLD', 'TV'])
    expect(r.topByAmount.map((i) => i.itemNumber)).toEqual(['TV', 'SOCKS', 'OLD'])
    const socks = r.items.find((i) => i.itemNumber === 'SOCKS')!
    expect(socks.returnRate).toBeCloseTo(3 / 4, 12)
    const old = r.items.find((i) => i.itemNumber === 'OLD')!
    expect(old.returnRate).toBeNull() // never purchased in the data: no denominator
    expect(r.dollarReturnRate).toBeCloseTo(52700 / 54000, 12)
    expect(r.unitReturnRate).toBeCloseTo((1 + 3) / (1 + 4), 12) // only items purchased in the data
  })

  it('does not invent time-to-return without sourcePurchaseId', () => {
    const r = buildAnalyticsSnapshot(data()).returns
    expect(r.timeToReturn.available).toBe(false)
  })

  it('measures time-to-return only when the purchase is actually linked', () => {
    const b = new DatasetBuilder()
    const receipt = b.buy('2024-01-01', 'X', 1000)
    b.ret({ itemNumber: 'X', date: '2024-01-11', sourcePurchaseId: receipt })
    b.ret({ itemNumber: 'X', date: '2024-02-01' })
    const t = buildAnalyticsSnapshot(b.build()).returns.timeToReturn
    expect(t).toEqual({ available: true, linkedReturns: 1, averageDays: 10, medianDays: 10 })
  })

  it('flags items returned in larger quantities than purchased', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', 'X', 1000, 1)
    b.ret({ itemNumber: 'X', quantity: 2 })
    const s = buildAnalyticsSnapshot(b.build())
    expect(s.returns.items[0]!.returnsExceedPurchases).toBe(true)
    expect(s.quality.itemsWithReturnsExceedingPurchases).toEqual(['X'])
  })
})

describe('price adjustments', () => {
  it('totals recorded savings without using transaction totals', () => {
    const a = buildAnalyticsSnapshot(data()).adjustments
    expect(a.count).toBe(3)
    expect(a.totalCents).toBe(5200)
    expect(a.averageCents).toBe(Math.round(5200 / 3))
    expect(a.largest).toMatchObject({ itemNumber: 'TV', amountCents: 4000 })
    expect(a.byMonth.map((m) => [m.month, m.amountCents])).toEqual([
      ['2024-01', 4000],
      ['2024-02', 1000],
    ])
    expect(a.undated.amountCents).toBe(200)
  })

  it('ranks items and computes savings rates', () => {
    const a = buildAnalyticsSnapshot(data()).adjustments
    expect(a.topByCount[0]).toMatchObject({ itemNumber: 'TV', count: 2, amountCents: 5000 })
    expect(a.topByAmount.map((i) => i.itemNumber)).toEqual(['TV', 'SOCKS'])
    expect(a.items.find((i) => i.itemNumber === 'TV')!.savingsRate).toBeCloseTo(5000 / 50000, 12)
    expect(a.overallSavingsRate).toBeCloseTo(5200 / 54000, 12)
    expect(a.adjustedItemsSavingsRate).toBeCloseTo(5200 / 54000, 12)
  })

  it('handles no adjustments', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', 'X', 100)
    const a = buildAnalyticsSnapshot(b.build()).adjustments
    expect(a).toMatchObject({ count: 0, totalCents: 0, averageCents: null, largest: null, overallSavingsRate: 0 })
  })
})
