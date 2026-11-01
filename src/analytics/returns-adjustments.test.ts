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

  it('ranks items and computes observed return ratios', () => {
    const s = buildAnalyticsSnapshot(data())
    const r = s.returns
    expect(r.topByCount.map((i) => i.itemNumber)).toEqual(['SOCKS', 'OLD', 'TV'])
    expect(r.topByAmount.map((i) => i.itemNumber)).toEqual(['TV', 'SOCKS', 'OLD'])
    const socks = r.items.find((i) => i.itemNumber === 'SOCKS')!
    expect(socks.observedUnitReturnRatio).toBeCloseTo(3 / 4, 12)
    const old = r.items.find((i) => i.itemNumber === 'OLD')!
    expect(old.observedUnitReturnRatio).toBeNull() // never purchased in the data: no denominator
    // OLD's $7 refund is for a purchase outside the data, yet it is in the numerator:
    // this is why the value is an observed ratio, not a return rate.
    expect(r.observedReturnValueRatio).toBeCloseTo(52700 / 54000, 12)
    expect(r.observedUnitReturnRatio).toBeCloseTo((1 + 3) / (1 + 4), 12) // only items purchased in the data
  })

  it('never presents observed ratios as purchase-linked return rates', () => {
    const r = buildAnalyticsSnapshot(data()).returns
    for (const legacy of ['dollarReturnRate', 'unitReturnRate', 'returnRate']) {
      expect(r).not.toHaveProperty(legacy)
      for (const i of r.items) expect(i).not.toHaveProperty(legacy)
    }
    expect(r.purchaseLinkedReturnRate).toEqual({
      available: false,
      linkedRecords: 0,
      unlinkedRecords: 4,
      reason: expect.stringMatching(/sourcePurchaseId is empty/),
    })
    expect(buildAnalyticsSnapshot(data()).quality.limitations.join(' ')).toMatch(/share of observed spend, not as true return or savings rates/)
  })

  it('observed return ratio can exceed 100% when returns predate the data', () => {
    const b = new DatasetBuilder()
    b.buy('2024-05-01', 'X', 1000)
    b.ret({ itemNumber: 'X', quantity: 3, amountCents: 3000, date: '2024-05-10' })
    const r = buildAnalyticsSnapshot(b.build()).returns
    expect(r.observedReturnValueRatio).toBe(3)
    expect(r.observedUnitReturnRatio).toBe(3)
    expect(r.purchaseLinkedReturnRate.available).toBe(false)
  })

  it('reports a purchase-linked return rate only when every return is linked', () => {
    const b = new DatasetBuilder()
    const p1 = b.buy('2024-01-01', 'X', 1000, 2)
    const p2 = b.buy('2024-01-05', 'Y', 500)
    b.buy('2024-01-06', 'Z', 9000)
    b.ret({ itemNumber: 'X', date: '2024-01-11', amountCents: 1000, sourcePurchaseId: p1 })
    const partial = new DatasetBuilder()
    const q1 = partial.buy('2024-01-01', 'X', 1000)
    partial.ret({ itemNumber: 'X', amountCents: 1000, sourcePurchaseId: q1 })
    partial.ret({ itemNumber: 'X', amountCents: 1000 })
    expect(buildAnalyticsSnapshot(partial.build()).returns.purchaseLinkedReturnRate).toMatchObject({
      available: false,
      linkedRecords: 1,
      unlinkedRecords: 1,
      reason: expect.stringMatching(/Only 1 of 2 returns/),
    })
    b.ret({ itemNumber: 'Y', date: '2024-01-12', amountCents: 500, sourcePurchaseId: p2 })
    const r = buildAnalyticsSnapshot(b.build()).returns
    expect(r.purchaseLinkedReturnRate).toEqual({ available: true, linkedRecords: 2, rate: 1500 / 2500, linkedPurchaseIds: [p1, p2].sort() })
    expect(r.observedReturnValueRatio).toBeCloseTo(1500 / 11500, 12) // still the observed ratio over all spend
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

  it('ranks items and computes observed adjustment ratios', () => {
    const a = buildAnalyticsSnapshot(data()).adjustments
    expect(a.topByCount[0]).toMatchObject({ itemNumber: 'TV', count: 2, amountCents: 5000 })
    expect(a.topByAmount.map((i) => i.itemNumber)).toEqual(['TV', 'SOCKS'])
    expect(a.items.find((i) => i.itemNumber === 'TV')!.observedValueRatio).toBeCloseTo(5000 / 50000, 12)
    expect(a.observedAdjustmentValueRatio).toBeCloseTo(5200 / 54000, 12)
    expect(a.observedAdjustedItemsValueRatio).toBeCloseTo(5200 / 54000, 12)
  })

  it('does not present observed adjustment ratios as purchase-linked savings rates', () => {
    const a = buildAnalyticsSnapshot(data()).adjustments
    for (const legacy of ['overallSavingsRate', 'adjustedItemsSavingsRate', 'savingsRate']) {
      expect(a).not.toHaveProperty(legacy)
      for (const i of a.items) expect(i).not.toHaveProperty(legacy)
    }
    expect(a.purchaseLinkedSavingsRate).toEqual({
      available: false,
      linkedRecords: 0,
      unlinkedRecords: 3,
      reason: expect.stringMatching(/No price adjustment is linked.*sourcePurchaseId is empty/),
    })
  })

  it('handles no adjustments', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', 'X', 100)
    const a = buildAnalyticsSnapshot(b.build()).adjustments
    expect(a).toMatchObject({ count: 0, totalCents: 0, averageCents: null, largest: null, observedAdjustmentValueRatio: 0 })
    expect(a.purchaseLinkedSavingsRate).toMatchObject({ available: false, reason: 'No price adjustments are recorded.' })
  })
})
