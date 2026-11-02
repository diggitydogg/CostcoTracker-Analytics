// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { categorize } from '../categories/engine'
import { buildAnalyticsSnapshot } from '../snapshot'
import { DatasetBuilder } from '../test/builder'
import { identityTexts, type ProductIdentity } from './identityProtocol'

const identity = (itemNumber: string, name: string, extra: Partial<ProductIdentity> = {}): ProductIdentity => ({
  itemNumber,
  status: 'resolved',
  receiptDescription: 'X',
  canonicalName: name,
  brand: null,
  productType: null,
  confidence: 0.9,
  basis: 'costco.com',
  method: 'web-search',
  resolvedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
})

describe('deterministic rules on identified products', () => {
  it('matches the identified name only when no receipt description matches', () => {
    // Receipt text matches → unchanged, identity ignored.
    expect(categorize('1', ['KS PAPER TOWELS'], {}, undefined, ['Anker Power Bank'])).toMatchObject({ categoryId: 'paper-goods', basis: 'receipt' })
    // Identified, but no rule knows the product → still Uncategorized (the AI step, with review, handles it).
    expect(categorize('2', ['CLASSIC BLUE'], {}, undefined, ['Brondell Swash Bidet Toilet Seat', 'bidet toilet seat'])).toMatchObject({
      categoryId: 'uncategorized',
      source: 'fallback',
    })
    // Receipt text is an unknown abbreviation, the identified name matches a rule → the rule decides.
    expect(categorize('3', ['ANKERSOLIX'], {}, undefined, ['Anker SOLIX C1000 Portable Power Station'])).toMatchObject({
      categoryId: 'electronics',
      source: 'rule',
      basis: 'identity',
      matchedPhrase: 'ANKER',
    })
    // The owner's override still wins.
    expect(categorize('3', ['ANKERSOLIX'], { '3': { categoryId: 'home' } }, undefined, ['Anker Power Bank'])).toMatchObject({ categoryId: 'home', source: 'override' })
  })

  it('uses only identities backed by Costco.com, a specialist page, two agreeing sources, or the owner', () => {
    expect(identityTexts(identity('1', 'Anker Power Bank', { productType: 'power bank' }))).toEqual(['Anker Power Bank', 'power bank'])
    expect(identityTexts(identity('1', 'Anker Power Bank', { basis: 'corroborated', confidence: 0.8 }))).toEqual(['Anker Power Bank'])
    expect(identityTexts(identity('1', 'Synthetic Test Mat', { basis: 'costco-specialist', confidence: 0.85 }))).toEqual(['Synthetic Test Mat'])
    expect(identityTexts(identity('1', 'Synthetic Rain Boot', { basis: 'owner-confirmed', confidence: 1, method: 'owner', productType: 'rain boot' }))).toEqual(['Synthetic Rain Boot', 'rain boot'])
    // Defensive: a record that is somehow not trusted is never used.
    expect(identityTexts(identity('1', 'Anker Power Bank', { basis: 'single-source' as never }))).toEqual([])
    expect(identityTexts(identity('1', 'Anker Power Bank', { confidence: 0.5 }))).toEqual([])
    expect(identityTexts({ ...identity('1', 'x'), status: 'unresolved' as never })).toEqual([])
    expect(identityTexts(undefined)).toEqual([])
  })

  it('an owner-confirmed identity categorizes through the deterministic rules like any resolved one', () => {
    const b = new DatasetBuilder()
    b.buy('2026-03-01', '9200001', 4_999, 1, { description: 'SYN NECT' })
    const data = b.build()
    expect(buildAnalyticsSnapshot(data).items.byItemNumber.get('9200001')!.category.categoryId).toBe('uncategorized')
    const owner = identity('9200001', 'Synthetic Yellow Nectarines', { basis: 'owner-confirmed', confidence: 1, method: 'owner' })
    const s = buildAnalyticsSnapshot(data, { productIdentities: { '9200001': owner } })
    expect(s.items.byItemNumber.get('9200001')!.category).toMatchObject({ categoryId: 'grocery', subcategoryId: 'produce', source: 'rule', basis: 'identity' })
    expect(s.items.byItemNumber.get('9200001')!.identity?.basis).toBe('owner-confirmed')
    // Removing the identity puts it back exactly as before.
    expect(buildAnalyticsSnapshot(data, { productIdentities: {} }).items.byItemNumber.get('9200001')!.category.categoryId).toBe('uncategorized')
  })

  it('flows through the snapshot, keeps totals reconciled and exposes the identity for traceability', () => {
    const b = new DatasetBuilder()
    b.buy('2026-03-01', '101', 49_999, 1, { description: 'ANKERSOLIX' })
    b.buy('2026-03-02', '100', 1_999, 1, { description: 'KS PAPER TOWELS' })
    const data = b.build()
    const before = buildAnalyticsSnapshot(data)
    expect(before.items.byItemNumber.get('101')!.category.categoryId).toBe('uncategorized')
    const s = buildAnalyticsSnapshot(data, { productIdentities: { '101': identity('101', 'Anker SOLIX C1000 Portable Power Station') } })
    expect(s.items.byItemNumber.get('101')!.category).toMatchObject({ categoryId: 'electronics', basis: 'identity' })
    expect(s.items.byItemNumber.get('101')!.identity?.basis).toBe('costco.com')
    expect(s.items.byItemNumber.get('100')!.category).toMatchObject({ categoryId: 'paper-goods', basis: 'receipt' })
    expect(s.categories.categories.reduce((t, c) => t + c.spendCents, 0)).toBe(s.spending.lifetime.grossCents)
    // Purchase analytics are untouched by identities.
    expect(s.spending).toEqual(before.spending)
    // A record below the usable confidence is shown but does not categorize.
    const p = buildAnalyticsSnapshot(data, { productIdentities: { '101': identity('101', 'Anker SOLIX C1000 Portable Power Station', { confidence: 0.5 }) } })
    expect(p.items.byItemNumber.get('101')!.category.categoryId).toBe('uncategorized')
    expect(p.items.byItemNumber.get('101')!.identity?.canonicalName).toBe('Anker SOLIX C1000 Portable Power Station')
  })
})
