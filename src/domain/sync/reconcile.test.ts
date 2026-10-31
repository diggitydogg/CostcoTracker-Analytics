// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MASS_REMOVAL_GUARD, countPlan, hashReceiptBundle, planBatch, planKind, planMissing } from './reconcile'
import type { ReceiptBundle } from './protocol'

const bundle: ReceiptBundle = {
  id: 'r_1',
  sourceType: 'synthetic',
  identifierKind: 'synthetic',
  purchaseDate: '2026-01-01',
  warehouse: null,
  items: [
    { id: 'i_a', itemNumber: '1', description: 'A', quantity: 1, lineTotalCents: 100, unitPriceCents: 100 },
    { id: 'i_b', itemNumber: '2', description: 'B', quantity: 2, lineTotalCents: 300, unitPriceCents: 150 },
  ],
}

describe('hashReceiptBundle', () => {
  it('ignores item order but detects any item change', async () => {
    const base = await hashReceiptBundle(bundle)
    expect(await hashReceiptBundle({ ...bundle, items: [...bundle.items].reverse() })).toBe(base)
    const changed = { ...bundle, items: [bundle.items[0]!, { ...bundle.items[1]!, lineTotalCents: 301, unitPriceCents: null }] }
    expect(await hashReceiptBundle(changed)).not.toBe(base)
    expect(await hashReceiptBundle({ ...bundle, items: [bundle.items[0]!] })).not.toBe(base)
    expect(await hashReceiptBundle({ ...bundle, warehouse: 'X' })).not.toBe(base)
  })
})

describe('planKind', () => {
  it('classifies insert, update, revive and unchanged', () => {
    const incoming = new Map([
      ['new', 'h1'],
      ['changed', 'h2'],
      ['back', 'h3'],
      ['same', 'h4'],
      ['changedAndMissing', 'h5'],
    ])
    const stored = new Map([
      ['changed', { hash: 'old', missing: false }],
      ['back', { hash: 'h3', missing: true }],
      ['same', { hash: 'h4', missing: false }],
      ['changedAndMissing', { hash: 'old', missing: true }],
      ['untouched', { hash: 'h9', missing: false }],
    ])
    expect(planKind(incoming, stored)).toEqual({
      insert: ['new'],
      update: ['changed', 'changedAndMissing'],
      revive: ['back'],
      unchanged: ['same'],
    })
  })

  it('counts rows per kind for manifest verification', () => {
    const plan = planBatch(
      { receipts: new Map([['a', 'x']]), returns: new Map(), priceAdjustments: new Map([['p', 'y'], ['q', 'z']]) },
      { receipts: new Map(), returns: new Map(), priceAdjustments: new Map([['p', { hash: 'y', missing: false }]]) },
    )
    const counts = countPlan(plan, 3)
    expect(counts.rows).toEqual({ receipts: 1, returns: 0, priceAdjustments: 2 })
    expect(counts.priceAdjustments).toEqual({ inserted: 1, updated: 0, revived: 0, unchanged: 1 })
    expect(counts.itemsWritten).toBe(3)
  })
})

describe('planMissing', () => {
  const ids = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

  it('tombstones stored rows absent from the manifest', () => {
    expect(planMissing(ids(10), ids(10).slice(1))).toEqual({ toTombstone: ['r0'], guardTripped: false })
  })

  it('ignores manifest IDs that are not stored yet', () => {
    expect(planMissing(ids(2), [...ids(2), 'new'])).toEqual({ toTombstone: [], guardTripped: false })
  })

  it('trips the guard above the removal fraction', () => {
    const live = ids(10)
    expect(planMissing(live, live.slice(3)).guardTripped).toBe(true) // 30% > 20%
    expect(planMissing(live, live.slice(2)).guardTripped).toBe(false) // exactly 20%
  })

  it('trips the guard above the absolute row limit even when the fraction is small', () => {
    const live = ids(1000)
    const removed = MASS_REMOVAL_GUARD.maxRows + 1
    expect(planMissing(live, live.slice(removed)).guardTripped).toBe(true)
    expect(planMissing(live, live.slice(MASS_REMOVAL_GUARD.maxRows)).guardTripped).toBe(false)
  })

  it('trips the guard for an empty manifest against stored data (wiped source)', () => {
    expect(planMissing(ids(3), [])).toEqual({ toTombstone: ['r0', 'r1', 'r2'], guardTripped: true })
  })

  it('does nothing for an empty store', () => {
    expect(planMissing([], [])).toEqual({ toTombstone: [], guardTripped: false })
  })
})
