// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ProductIdentity } from './identityProtocol'
import {
  canSaveIdentity,
  combineEvidence,
  confirmMatch,
  decide,
  evidenceFromText,
  matchLocal,
  mergeExternal,
  needsExternal,
  photoSearchRequest,
  PHOTO_MATCH,
  visibleNumbers,
  type MatchableItem,
  type PhotoEvidence,
} from './photoMatch'

const identity = (itemNumber: string, canonicalName: string, extra: Partial<ProductIdentity> = {}): ProductIdentity => ({
  itemNumber,
  status: 'resolved',
  receiptDescription: 'X',
  canonicalName,
  brand: null,
  productType: null,
  confidence: 0.9,
  basis: 'costco.com',
  method: 'web-search',
  resolvedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})
const item = (itemNumber: string, descriptions: string[], id: ProductIdentity | null = null, purchaseEvents = 2): MatchableItem => ({
  itemNumber,
  descriptions,
  identity: id,
  purchaseEvents,
  lastPurchaseDate: '2026-03-01',
})

const ITEMS: MatchableItem[] = [
  item('9300001', ['KS TORT PASTA'], identity('9300001', 'Kirkland Signature Tortellini Pasta Salad', { brand: 'Kirkland Signature' })),
  item('9300002', ['SYN OLIVE OIL 2L']),
  item('9300003', ['SYN BATH TOWEL 6PK'], identity('9300003', 'Synthetic Hotel Bath Towels', { basis: 'owner-confirmed', confidence: 1, method: 'owner' })),
  item('9300004', ['SYN BATH SHEET'], identity('9300004', 'Synthetic Hotel Bath Sheets', { basis: 'costco.com' })),
  item('9300005', ['SYN PAPER TOWELS']),
]

const vision = (over: Partial<PhotoEvidence>): PhotoEvidence => ({
  source: 'ai-vision',
  quality: 'ok',
  brand: null,
  productName: null,
  variant: null,
  size: null,
  productType: null,
  modelNumber: null,
  barcodes: [],
  numbers: [],
  visibleText: [],
  ...over,
})

describe('deterministic on-device evidence', () => {
  it('reads standalone item numbers from OCR text, without inventing or joining numbers', () => {
    expect(visibleNumbers(['ITEM 9300002', 'SYN OLIVE OIL 2 L', '$12.99', 'Best by 2027', '9300001 48ct'])).toEqual(['9300002', '2027', '9300001'])
    expect(visibleNumbers(['1.234', '12,345', '123'])).toEqual([])
  })

  it('a Costco item number on a shelf tag (OCR) decides the match without any AI', () => {
    const e = evidenceFromText(['SYNTHETIC OLIVE OIL', 'Item 9300002', '$15.99'], [], 'on-device')
    const local = matchLocal(e, ITEMS)
    expect(local[0]).toMatchObject({ itemNumber: '9300002', confidence: 0.97, sources: ['on-device', 'local-catalog'] })
    expect(decide(e, local, false).status).toBe('match')
    expect(needsExternal(e, local)).toBe(false)
  })

  it('a barcode whose value is the item number decides the match', () => {
    const e = evidenceFromText([], [{ format: 'code_128', value: '9300005' }], 'on-device')
    expect(matchLocal(e, ITEMS)[0]).toMatchObject({ itemNumber: '9300005', confidence: 0.97 })
  })

  it('packaging text read on the device matches abbreviated receipt text and catalog names', () => {
    const e = evidenceFromText(['KIRKLAND', 'SIGNATURE', 'TORTELLINI PASTA SALAD', 'with mozzarella'], [], 'on-device')
    const [top] = matchLocal(e, ITEMS)
    expect(top).toMatchObject({ itemNumber: '9300001' })
    expect(top!.confidence).toBeGreaterThanOrEqual(PHOTO_MATCH.strong)
    expect(top!.reasons.join(' ')).toMatch(/Text in the photo matches your catalog: Kirkland Signature Tortellini Pasta Salad/)
  })

  it('unreadable photos are reported as such, with no candidates', () => {
    const e = evidenceFromText([' ', '~'], [], 'on-device')
    expect(e.quality).toBe('blurry')
    expect(decide(e, matchLocal(e, ITEMS), false)).toMatchObject({ status: 'unreadable', candidates: [] })
  })
})

describe('local matching and ranking', () => {
  it('a strong local match from structured (AI vision) evidence', () => {
    const e = vision({ brand: 'Synthetic', productName: 'Olive Oil', size: '2 L' })
    const r = decide(e, matchLocal(e, ITEMS), false)
    expect(r.status).toBe('match')
    expect(r.candidates[0]).toMatchObject({ itemNumber: '9300002', sources: ['image', 'local-catalog'] })
  })

  it('prefers the owner-confirmed identity when two items fit', () => {
    const e = vision({ productName: 'Hotel Bath', brand: 'Synthetic' })
    const ranked = matchLocal(e, ITEMS)
    expect(ranked.map((c) => c.itemNumber).slice(0, 2)).toEqual(['9300003', '9300004'])
    expect(ranked[0]).toMatchObject({ ownerConfirmed: true })
    expect(ranked[0]!.reasons).toContain('You confirmed this product')
  })

  it('several plausible candidates are presented as candidates, not as one match', () => {
    const e = vision({ productName: 'Bath Towels' })
    const r = decide(e, matchLocal(e, ITEMS), false)
    expect(['candidates', 'low-confidence']).toContain(r.status)
    expect(r.candidates.length).toBeGreaterThan(1)
  })

  it('no candidate when nothing matches', () => {
    const e = vision({ brand: 'Acme', productName: 'Garden Hose Reel' })
    expect(decide(e, matchLocal(e, ITEMS), true)).toMatchObject({ status: 'none', candidates: [] })
  })

  it('a single matching word is not enough to show anything', () => {
    expect(decide(evidenceFromText(['TOWELS'], [], 'on-device'), matchLocal(evidenceFromText(['TOWELS'], [], 'on-device'), ITEMS), false).status).toBe('none')
  })

  it('a weak match is labelled low-confidence', () => {
    const e = vision({ productName: 'Towel Warmer' })
    const r = decide(e, matchLocal(e, ITEMS), false)
    expect(r.status).toBe('low-confidence')
    expect(r.candidates[0]!.confidence).toBeLessThan(PHOTO_MATCH.plausible)
  })
})

describe('Costco receipt conventions', () => {
  it('"KS" on a receipt matches the Kirkland Signature brand read from a photo', () => {
    const e = vision({ brand: 'Kirkland Signature', productName: 'Olive Oil' })
    const [top] = matchLocal(e, [item('9300009', ['KS OLIVE OIL 2L'])])
    expect(top!.reasons).toContain('Brand Kirkland Signature matches')
    expect(top!.confidence).toBeGreaterThanOrEqual(PHOTO_MATCH.strong)
  })
})

describe('external fallback', () => {
  it('runs only for a named product without a strong local match, and sends only brand/name/variant', () => {
    const e = vision({ brand: 'Acme', productName: 'Cordless "Drill"*', variant: '20V', size: '2 pack', numbers: ['1234'], visibleText: ['SECRET'] })
    expect(needsExternal(e, matchLocal(e, ITEMS))).toBe(true)
    expect(photoSearchRequest(e)).toEqual({ brand: 'Acme', productName: 'Cordless Drill', variant: '20V' })
    expect(photoSearchRequest(vision({ brand: 'Acme' }))).toBeNull()
  })

  it('merges external item numbers: purchased ones combine with local evidence, others are "not in your purchases"', () => {
    const e = vision({ brand: 'Synthetic', productName: 'Paper Towels' })
    const local = matchLocal(e, ITEMS)
    const merged = mergeExternal(
      e,
      local,
      [
        { itemNumber: '9300005', title: 'Synthetic Paper Towels, 12 Rolls', basis: 'costco.com' },
        { itemNumber: '9999999', title: 'Synthetic Paper Towels, Select-A-Size', basis: 'costco-specialist' },
      ],
      ITEMS,
    )
    const bought = merged.find((c) => c.itemNumber === '9300005')!
    expect(bought.sources).toEqual(['image', 'local-catalog', 'external'])
    expect(bought.purchases).not.toBeNull()
    const other = merged.find((c) => c.itemNumber === '9999999')!
    expect(other).toMatchObject({ purchases: null, identity: null, externalBasis: 'costco-specialist' })
    expect(canSaveIdentity(other)).toBe(false)
    expect(confirmMatch(other, new Date())).toBeNull()
  })

  it('combines on-device and AI evidence so nothing read on the device is lost', () => {
    const device = evidenceFromText(['Item 9300002'], [{ format: 'ean_13', value: '0012345678905' }], 'on-device')
    const both = combineEvidence(device, vision({ productName: 'Olive Oil' }))
    expect(both).toMatchObject({ source: 'ai-vision', numbers: ['9300002'], productName: 'Olive Oil' })
    expect(both.barcodes).toHaveLength(1)
  })
})

describe('confirmation never overwrites an identity', () => {
  it('only an item without any identity may be saved, through the owner-confirmed workflow', () => {
    const e = vision({ productName: 'Olive Oil' })
    const [olive] = matchLocal(e, ITEMS)
    expect(canSaveIdentity(olive!)).toBe(true)
    const owner = matchLocal(vision({ productName: 'Hotel Bath Towels' }), ITEMS)[0]!
    expect(owner.ownerConfirmed).toBe(true)
    expect(canSaveIdentity(owner)).toBe(false)
    const automatic = matchLocal(vision({ productName: 'Tortellini Pasta Salad' }), ITEMS)[0]!
    expect(canSaveIdentity(automatic)).toBe(false)
  })

  it('the confirmed result carries what the return assistant will need', () => {
    const e = evidenceFromText(['Item 9300003'], [], 'on-device')
    const c = matchLocal(e, ITEMS)[0]!
    expect(confirmMatch(c, new Date('2026-11-02T00:00:00Z'))).toEqual({
      itemNumber: '9300003',
      canonicalName: 'Synthetic Hotel Bath Towels',
      identity: expect.objectContaining({ basis: 'owner-confirmed' }),
      confidence: 0.97,
      confirmation: 'owner-confirmed-match',
      sources: ['on-device', 'local-catalog'],
      confirmedAt: '2026-11-02T00:00:00.000Z',
    })
  })
})
