// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from './snapshot'
import { DatasetBuilder } from './test/builder'

describe('warehouses and channels', () => {
  function data() {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', '1', 1000, 1, { warehouse: 'SYNTHETIC NORTH' })
    b.buy('2024-01-02', '2', 3000, 1, { warehouse: '  synthetic   north ' })
    b.buy('2024-01-03', '1', 2000, 1, { warehouse: 'SYNTHETIC NORTHGATE' })
    b.buy('2024-01-04', '3', 500, 1, { warehouse: 'Warehouse' })
    b.buy('2024-01-05', '3', 700, 1, { warehouse: null })
    b.buy('2024-01-06', '4', 9000, 1, { source: 'online', warehouse: 'Online Order (Fulfilling Whse #9001)' })
    b.buy('2024-01-07', '5', 100, 1, { source: 'synthetic', warehouse: null })
    b.receipt({ date: '2024-01-08', warehouse: 'SYNTHETIC NORTH' }) // no lines
    return b.build()
  }

  it('merges only case/whitespace variants and never guesses', () => {
    const w = buildAnalyticsSnapshot(data()).warehouses
    const north = w.groups.find((g) => g.kind === 'store' && g.label === 'SYNTHETIC NORTH')!
    expect(north.events).toBe(3)
    expect(north.spendCents).toBe(4000)
    expect(north.averageBasketCents).toBe(2000) // the lineless receipt has no basket
    expect(north.uniqueItems).toBe(2)
    expect(north.variants).toEqual(['SYNTHETIC NORTH', '  synthetic   north '])
    expect(w.groups.find((g) => g.label === 'SYNTHETIC NORTHGATE')!.events).toBe(1)
  })

  it('labels placeholder, unknown, online and synthetic groups explicitly', () => {
    const w = buildAnalyticsSnapshot(data()).warehouses
    const kinds = Object.fromEntries(w.groups.map((g) => [g.kind, g.label]))
    expect(kinds).toMatchObject({
      placeholder: 'Unknown warehouse (name not recorded)',
      unknown: 'Unknown warehouse',
      'online-fulfillment': 'Online Order (Fulfilling Whse #9001)',
      synthetic: 'Synthetic data',
    })
  })

  it('splits channels and reconciles with gross spend', () => {
    const s = buildAnalyticsSnapshot(data())
    const c = s.warehouses.channels
    expect(c.warehouse).toMatchObject({ events: 6, spendCents: 7200 })
    expect(c.online).toMatchObject({ events: 1, spendCents: 9000, averageBasketCents: 9000 })
    expect(c.synthetic).toMatchObject({ events: 1, spendCents: 100 })
    expect(c.warehouse.spendShare! + c.online.spendShare! + c.synthetic.spendShare!).toBeCloseTo(1, 12)
    expect(s.warehouses.groups.reduce((t, g) => t + g.spendCents, 0)).toBe(s.spending.lifetime.grossCents)
    expect(s.warehouses.groups.reduce((t, g) => t + g.events, 0)).toBe(s.trips.eventCount)
  })
})
