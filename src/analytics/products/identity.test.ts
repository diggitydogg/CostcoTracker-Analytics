// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { categorize } from '../categories/engine'
import { buildAnalyticsSnapshot } from '../snapshot'
import { DatasetBuilder } from '../test/builder'
import { identityTexts, type ProductIdentity } from './identityProtocol'

const identity = (itemNumber: string, name: string, extra: Partial<ProductIdentity> = {}): ProductIdentity => ({
  itemNumber,
  status: 'identified',
  receiptDescription: 'X',
  normalizedName: name,
  brand: null,
  productType: null,
  sourceUrl: 'https://www.costco.com/x.html',
  imageUrl: null,
  confidence: 0.9,
  evidence: 'costco.com',
  evidenceSources: 1,
  corroboratingUrl: null,
  method: 'web-search',
  lookedUpAt: '2026-11-01T00:00:00.000Z',
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

  it('uses only identities backed by Costco.com or two agreeing independent sources', () => {
    expect(identityTexts(identity('1', 'Anker Power Bank', { productType: 'power bank' }))).toEqual(['Anker Power Bank', 'power bank'])
    expect(identityTexts(identity('1', 'Anker Power Bank', { evidence: 'corroborated', evidenceSources: 2, confidence: 0.8 }))).toEqual(['Anker Power Bank'])
    // One non-Costco page is never enough, whatever the stored status or confidence says.
    expect(identityTexts(identity('1', 'Anker Power Bank', { status: 'provisional', evidence: 'single-source', confidence: 0.4 }))).toEqual([])
    expect(identityTexts(identity('1', 'Anker Power Bank', { evidence: 'single-source', confidence: 0.9 }))).toEqual([])
    expect(identityTexts(identity('1', 'Anker Power Bank', { evidence: null }))).toEqual([])
    expect(identityTexts(identity('1', 'Anker Power Bank', { confidence: 0.5 }))).toEqual([])
    expect(identityTexts({ ...identity('1', 'x'), status: 'not_found', normalizedName: null, evidence: null })).toEqual([])
    expect(identityTexts(undefined)).toEqual([])
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
    expect(s.items.byItemNumber.get('101')!.identity?.sourceUrl).toBe('https://www.costco.com/x.html')
    expect(s.items.byItemNumber.get('100')!.category).toMatchObject({ categoryId: 'paper-goods', basis: 'receipt' })
    expect(s.categories.categories.reduce((t, c) => t + c.spendCents, 0)).toBe(s.spending.lifetime.grossCents)
    // Purchase analytics are untouched by identities.
    expect(s.spending).toEqual(before.spending)
    // A provisional (single-source) identity is shown but does not categorize.
    const p = buildAnalyticsSnapshot(data, {
      productIdentities: { '101': identity('101', 'Anker SOLIX C1000 Portable Power Station', { status: 'provisional', evidence: 'single-source', confidence: 0.4 }) },
    })
    expect(p.items.byItemNumber.get('101')!.category.categoryId).toBe('uncategorized')
    expect(p.items.byItemNumber.get('101')!.identity?.status).toBe('provisional')
  })
})
