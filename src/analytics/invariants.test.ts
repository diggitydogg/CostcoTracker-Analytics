// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { importExportText } from '../domain/import/importExport'
import { syntheticExportText } from '../test/fixtures'
import { buildAnalyticsSnapshot, type AnalyticsSnapshot } from './snapshot'
import { DatasetBuilder, generateDataset } from './test/builder'

/** Walks every value reachable from the snapshot (Maps included). */
function* numbersIn(value: unknown, path = '$', seen = new Set<unknown>()): Generator<[string, number]> {
  if (typeof value === 'number') {
    yield [path, value]
    return
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (value instanceof Map) {
    for (const [k, v] of value) yield* numbersIn(v, `${path}.${String(k)}`, seen)
    return
  }
  for (const [k, v] of Object.entries(value)) yield* numbersIn(v, `${path}.${k}`, seen)
}

function checkInvariants(s: AnalyticsSnapshot) {
  const L = s.spending.lifetime
  // Net reconciles exactly.
  expect(L.netCents).toBe(L.grossCents - L.refundCents - L.adjustmentCents)
  // Gross equals the sum of every item line.
  expect(L.grossCents).toBe(s.index.lines.reduce((t, l) => t + l.lineTotalCents, 0))
  // Refunds: recorded merchandise amounts only; adjustments: recorded amounts only.
  expect(L.refundCents).toBe(s.index.returns.reduce((t, r) => t + (r.merchandiseAmountCents ?? 0), 0))
  expect(L.adjustmentCents).toBe(s.index.adjustments.reduce((t, a) => t + a.amountCents, 0))
  // Time buckets + undated reconcile to lifetime, for every measure.
  for (const key of ['grossCents', 'refundCents', 'adjustmentCents', 'netCents'] as const) {
    expect(s.spending.monthly.reduce((t, m) => t + m[key], 0) + s.spending.undated[key]).toBe(L[key])
    expect(s.spending.yearly.reduce((t, y) => t + y[key], 0) + s.spending.undated[key]).toBe(L[key])
  }
  // Every money integer is an integer.
  for (const m of s.spending.monthly) expect(Number.isInteger(m.grossCents)).toBe(true)
  // Category spend = categorized + uncategorized = gross.
  expect(s.categories.categories.reduce((t, c) => t + c.spendCents, 0)).toBe(L.grossCents)
  // Item spend and quantity reconcile.
  expect(s.items.items.reduce((t, i) => t + i.totalSpentCents, 0)).toBe(L.grossCents)
  // Warehouses and channels reconcile with gross and event count.
  expect(s.warehouses.groups.reduce((t, g) => t + g.spendCents, 0)).toBe(L.grossCents)
  expect(s.warehouses.groups.reduce((t, g) => t + g.events, 0)).toBe(s.trips.eventCount)
  const ch = s.warehouses.channels
  expect(ch.warehouse.spendCents + ch.online.spendCents + ch.synthetic.spendCents).toBe(L.grossCents)
  expect(s.spending.bySource.warehouse.grossCents + s.spending.bySource.online.grossCents + s.spending.bySource.synthetic.grossCents).toBe(L.grossCents)
  // Trips by month + undated = all events.
  expect(s.trips.byMonth.reduce((t, m) => t + m.count, 0) + s.trips.undatedCount).toBe(s.trips.eventCount)
  // Returns and adjustments by month + undated reconcile.
  expect(s.returns.byMonth.reduce((t, m) => t + m.amountCents, 0) + s.returns.undated.amountCents).toBe(s.returns.amountCents)
  expect(s.adjustments.byMonth.reduce((t, m) => t + m.amountCents, 0) + s.adjustments.undated.amountCents).toBe(s.adjustments.totalCents)
  // Cohorts partition the items.
  const cohortTotal = ['staple', 'dormant-staple', 'occasional', 'one-and-done', 'not-purchased'].reduce(
    (t, c) => t + s.items.cohorts[c as keyof typeof s.items.cohorts].length,
    0,
  )
  expect(cohortTotal).toBe(s.items.items.length)
  // Inflation weights sum to 1 where computed.
  for (const link of [...s.inflation.yearly.links, ...s.inflation.monthly.links]) {
    if (link.weightedRelative !== null) expect(link.items.reduce((t, i) => t + i.weight!, 0)).toBeCloseTo(1, 9)
  }
  // No NaN / Infinity anywhere in the output.
  for (const [path, n] of numbersIn(s)) {
    if (!Number.isFinite(n)) throw new Error(`Non-finite number at ${path}`)
  }
}

describe('analytics invariants', () => {
  it('hold on a generated multi-year dataset at real-data scale', () => {
    const data = generateDataset({ receipts: 193, itemsPerReceipt: 8, returns: 37, adjustments: 12, seed: 7 })
    const s = buildAnalyticsSnapshot(data)
    expect(s.trips.eventCount).toBe(193)
    checkInvariants(s)
  })

  it('hold for many random seeds', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      checkInvariants(buildAnalyticsSnapshot(generateDataset({ receipts: 80, itemsPerReceipt: 5, returns: 10, adjustments: 5, seed })))
    }
  })

  it('hold on empty and edge-case datasets', () => {
    checkInvariants(buildAnalyticsSnapshot(new DatasetBuilder().build()))
    const b = new DatasetBuilder()
    b.receipt({ date: null })
    b.ret({ itemNumber: 'x', date: null, amountCents: null })
    checkInvariants(buildAnalyticsSnapshot(b.build()))
  })

  it('hold on the bundled synthetic Export V1 fixture (local-file path)', () => {
    const result = importExportText(syntheticExportText())
    if (!result.ok) throw new Error('fixture')
    const s = buildAnalyticsSnapshot(result.data, { source: { source: 'local-file' } })
    checkInvariants(s)
    expect(s.quality.receiptsBySource).toEqual({ warehouse: 2, online: 1, synthetic: 1 })
  })

  it('is deterministic for the same input and as-of date', () => {
    const data = generateDataset({ receipts: 120, itemsPerReceipt: 6, returns: 12, adjustments: 6, seed: 11 })
    const a = buildAnalyticsSnapshot(data, { asOf: '2026-01-01' })
    const b = buildAnalyticsSnapshot(structuredClone(data), { asOf: '2026-01-01' })
    const strip = (s: AnalyticsSnapshot) => JSON.stringify({ ...s, index: undefined, items: { ...s.items, byItemNumber: undefined, priceHistories: [...s.items.priceHistories] } })
    expect(strip(a)).toBe(strip(b))
  })

  it('handles 10× the real dataset quickly and reconciles', () => {
    const data = generateDataset({ receipts: 1930, itemsPerReceipt: 8, returns: 370, adjustments: 120, seed: 99, catalog: 1500 })
    expect(data.items.length).toBeGreaterThan(10_000)
    const started = performance.now()
    const s = buildAnalyticsSnapshot(data)
    const elapsed = performance.now() - started
    checkInvariants(s)
    // Generous bound for slow CI machines; typically well under a second.
    expect(elapsed).toBeLessThan(5000)
  })
})
