// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from './snapshot'
import { DatasetBuilder } from './test/builder'

describe('trips', () => {
  function data() {
    const b = new DatasetBuilder()
    const a = b.receipt({ date: '2024-01-01' }) // Monday
    b.item(a, { itemNumber: '1', unitPriceCents: 1000 })
    b.item(a, { itemNumber: '2', unitPriceCents: 500, quantity: 2 })
    const sameDay = b.receipt({ date: '2024-01-01', source: 'online' })
    b.item(sameDay, { itemNumber: '3', unitPriceCents: 250 })
    const c = b.receipt({ date: '2024-01-15' }) // Monday
    b.item(c, { itemNumber: '1', unitPriceCents: 1000, quantity: 0.5, lineTotalCents: 500 })
    const d = b.receipt({ date: '2024-03-20' }) // Wednesday
    b.item(d, { itemNumber: '4', unitPriceCents: 9000 })
    b.receipt({ date: '2024-03-21' }) // no exported lines
    const u = b.receipt({ date: null })
    b.item(u, { itemNumber: '5', unitPriceCents: 100 })
    return { data: b.build(), ids: { a, sameDay, c, d } }
  }

  it('counts events by source and month', () => {
    const t = buildAnalyticsSnapshot(data().data).trips
    expect(t.eventCount).toBe(6)
    expect(t.bySource).toEqual({ warehouse: 5, online: 1, synthetic: 0 })
    expect(t.byMonth.map((m) => [m.month, m.count])).toEqual([
      ['2024-01', 3],
      ['2024-03', 2],
    ])
    expect(t.undatedCount).toBe(1)
  })

  it('estimates baskets from line totals and leaves out events without lines', () => {
    const { data: d, ids } = data()
    const t = buildAnalyticsSnapshot(d).trips
    expect(t.basket.eventsWithBasket).toBe(5)
    expect(t.eventsWithoutLines.count).toBe(1)
    expect(t.basket.largest[0]).toMatchObject({ id: ids.d, basketCents: 9000 })
    expect(t.basket.largest[1]).toMatchObject({ id: ids.a, basketCents: 2000, lineCount: 2, units: 3 })
    expect(t.basket.smallest[0]!.basketCents).toBe(100)
    expect(t.basket.averageCents).toBe(Math.round((2000 + 250 + 500 + 9000 + 100) / 5))
    expect(t.basket.medianCents).toBe(500)
  })

  it('measures intervals between distinct shopping days', () => {
    const t = buildAnalyticsSnapshot(data().data).trips
    // Days: 01-01 (two receipts, one day), 01-15, 03-20, 03-21.
    expect(t.intervals.shoppingDays).toBe(4)
    expect(t.intervals.longestGap).toEqual({ days: 65, from: '2024-01-15', to: '2024-03-20' })
    expect(t.intervals.averageDays).toBeCloseTo((14 + 65 + 1) / 3, 10)
    expect(t.intervals.medianDays).toBe(14)
  })

  it('counts weekdays and months of year for dated events only', () => {
    const t = buildAnalyticsSnapshot(data().data).trips
    expect(t.weekdays.find((w) => w.name === 'Monday')!.count).toBe(3)
    expect(t.weekdays.reduce((s, w) => s + w.count, 0)).toBe(5)
    expect(t.busiestWeekdays).toEqual(['Monday'])
    expect(t.busiestMonthsOfYear).toEqual([1])
    expect(t.busiestMonths).toEqual(['2024-01'])
  })
})
