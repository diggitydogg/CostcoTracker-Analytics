// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from '../snapshot'
import { DatasetBuilder } from '../test/builder'
import { categorize, matchRules, parseCategoryOverrides, serializeCategoryOverrides, tokenize, withOverride } from './engine'

const cases: [string, string, string | null][] = [
  // Grocery
  ['KS BANANAS 3 LB', 'grocery', 'produce'],
  ['ORGANIC STRAWBERRIES 2 LB', 'grocery', 'produce'],
  ['HASS AVOCADOS 6 CT', 'grocery', 'produce'],
  ['MINI PEPPERS 2 LB', 'grocery', 'produce'],
  ['SWEET POTATOES 5 LB', 'grocery', 'produce'],
  ['ROMAINE HEARTS 6 CT', 'grocery', 'produce'],
  ['ROTISSERIE CHICKEN', 'grocery', 'meat-seafood'],
  ['KS ATLANTIC SALMON FILLET', 'grocery', 'meat-seafood'],
  ['GROUND BEEF 88/12', 'grocery', 'meat-seafood'],
  ['KS BEEF HOT DOGS 14 CT', 'grocery', 'meat-seafood'],
  ['KS LARGE EGGS 24 CT', 'grocery', 'dairy-eggs'],
  ['KS GREEK YOGURT 48 OZ', 'grocery', 'dairy-eggs'],
  ['KS SHREDDED MOZZARELLA', 'grocery', 'dairy-eggs'],
  ['KS SALTED BUTTER 4 LB', 'grocery', 'dairy-eggs'],
  ['FROZEN BLUEBERRIES 4 LB', 'grocery', 'frozen'],
  ['KS VANILLA ICE CREAM', 'grocery', 'frozen'],
  ['CHICKEN POTSTICKERS', 'grocery', 'frozen'],
  ['TORTILLA CHIPS 3 LB', 'grocery', 'snacks'],
  ['KS MILK CHOCOLATE ALMONDS', 'grocery', 'snacks'],
  ['KS BEEF JERKY', 'grocery', 'snacks'],
  ['KS TRAIL MIX 4 LB', 'grocery', 'snacks'],
  ['KS SPARKLING WATER 35 CT', 'grocery', 'beverages'],
  ['KS COLOMBIAN COFFEE 3 LB', 'grocery', 'beverages'],
  ['KS ORANGE JUICE 2 PK', 'grocery', 'beverages'],
  ['OAT MILK 6 PK', 'grocery', 'beverages'],
  ['COCONUT WATER 12 PK', 'grocery', 'beverages'],
  ['KS ORGANIC PEANUT BUTTER', 'grocery', 'pantry'],
  ['KS EXTRA VIRGIN OLIVE OIL 2L', 'grocery', 'pantry'],
  ['JASMINE RICE 25 LB', 'grocery', 'pantry'],
  ['KS CHICKEN BROTH 6 PK', 'grocery', 'pantry'],
  ['KS MAPLE SYRUP', 'grocery', 'pantry'],
  ['SOURDOUGH BREAD 2 CT', 'grocery', 'bakery'],
  ['KS BAGELS 12 CT', 'grocery', 'bakery'],
  ['BUTTER CROISSANTS 12 CT', 'grocery', 'bakery'],
  ['FLOUR TORTILLAS 30 CT', 'grocery', 'bakery'],
  // Non-food
  ['KS PAPER TOWELS 12 ROLL', 'paper-goods', null],
  ['KS BATH TISSUE 30 ROLL', 'paper-goods', null],
  ['KS FACIAL TISSUE 12 PK', 'paper-goods', null],
  ['KS ULTRA CLEAN LAUNDRY DETERGENT', 'cleaning', null],
  ['KS DISHWASHER PODS 115 CT', 'cleaning', null],
  ['KS DISINFECTING WIPES 5 PK', 'cleaning', null],
  ['KS BABY WIPES 900 CT', 'personal-care', null],
  ['KS SHAMPOO 2 PK', 'personal-care', null],
  ['KS DIAPERS SIZE 4', 'personal-care', null],
  ['KS DAILY MULTIVITAMIN', 'health', null],
  ['KS FISH OIL 400 CT', 'health', null],
  ['IBUPROFEN 500 CT', 'health', null],
  ['MENS ATHLETIC SOCKS 6 PK', 'clothing', null],
  ['LADIES LEGGINGS', 'clothing', null],
  ['65 INCH 4K TV', 'electronics', null],
  ['HDMI CABLE 2 PK', 'electronics', null],
  ['WIRELESS EARBUDS', 'electronics', null],
  ['KS BATH TOWEL 2 PK', 'home', null],
  ['QUEEN SHEET SET', 'home', null],
  ['ROBOT VACUUM', 'home', null],
  ['CHRISTMAS ORNAMENTS 100 CT', 'seasonal', null],
  ['HALLOWEEN CANDY 300 CT', 'seasonal', null],
  ['KS MOTOR OIL 5W-30', 'automotive', null],
  ['WIPER BLADES 2 PK', 'automotive', null],
  ['KS DOG FOOD 40 LB', 'pet', null],
  ['KS CAT LITTER 40 LB', 'pet', null],
  ['KS CABERNET SAUVIGNON', 'alcohol', null],
  ['KS LIGHT BEER 48 CT', 'alcohol', null],
  ['KS HARD SELTZER 24 PK', 'alcohol', null],
  ['KS TRASH BAGS 200 CT', 'household', null],
  ['KS ALUMINUM FOIL', 'household', null],
  ['KS AA BATTERIES 48 CT', 'household', null],
  ['LED LIGHT BULBS 8 PK', 'household', null],
  // Unknown stays uncategorized rather than being guessed.
  ['WIDGET XL MYSTERY', 'uncategorized', null],
  ['', 'uncategorized', null],
]

describe('category rules', () => {
  it.each(cases)('%s → %s / %s', (description, category, sub) => {
    const a = categorize('1', [description])
    expect([a.categoryId, a.subcategoryId]).toEqual([category, sub])
  })

  it('explains which rule and phrase matched', () => {
    expect(categorize('1', ['KS ORGANIC PEANUT BUTTER'])).toMatchObject({
      source: 'rule',
      ruleId: 'specific-pantry',
      matchedPhrase: 'PEANUT BUTTER',
    })
  })

  it('matches whole tokens (and declared prefixes) only', () => {
    expect(tokenize('KS 5W-30 Motor-Oil')).toEqual(['KS', '5W', '30', 'MOTOR', 'OIL'])
    expect(matchRules('CATALOG HOLDER')).toBeNull() // "CAT" is a whole-token rule
    expect(matchRules('GINGER SNAPS')).toBeNull() // not "GIN"
    expect(matchRules('STRAWBERRY JAM')?.rule.id).toBe('pantry')
  })

  it('falls back through description variants, most recent first', () => {
    expect(categorize('1', ['MYSTERY THING', 'KS BANANAS'])).toMatchObject({ categoryId: 'grocery', subcategoryId: 'produce' })
  })
})

describe('category overrides', () => {
  it('override beats rules and leaves records untouched', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', '555', 1000, 1, { description: 'KS BANANAS' })
    const data = b.build()
    const before = JSON.stringify(data)
    const s = buildAnalyticsSnapshot(data, { categoryOverrides: { '555': { categoryId: 'pet' } } })
    expect(s.items.byItemNumber.get('555')!.category).toMatchObject({ categoryId: 'pet', source: 'override' })
    expect(JSON.stringify(data)).toBe(before)
  })

  it('ignores an override with an unknown category or subcategory', () => {
    const bad = { '1': { categoryId: 'grocery', subcategoryId: 'nope' } } as never
    expect(categorize('1', ['KS BANANAS'], bad).source).toBe('rule')
  })

  it('round-trips overrides through the file format and validates input', () => {
    const o = withOverride(withOverride({}, '2', { categoryId: 'grocery', subcategoryId: 'snacks' }), '1', { categoryId: 'home' })
    const parsed = parseCategoryOverrides(serializeCategoryOverrides(o))
    expect(parsed).toEqual({ ok: true, overrides: o })
    expect(parseCategoryOverrides('{').ok).toBe(false)
    expect(parseCategoryOverrides(JSON.stringify({ format: 'costcotracker-category-overrides', version: 1, overrides: { x: { categoryId: 'grocery', subcategoryId: 'tools' } } })).ok).toBe(false)
  })

  it('withOverride never mutates and can remove', () => {
    const a = { '1': { categoryId: 'home' as const } }
    const b = withOverride(a, '1', null)
    expect(a).toEqual({ '1': { categoryId: 'home' } })
    expect(b).toEqual({})
  })
})

describe('category spend', () => {
  it('sums to gross spend and reports the uncategorized share', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', '1', 1000, 1, { description: 'KS BANANAS' })
    b.buy('2024-01-01', '2', 3000, 1, { description: 'KS PAPER TOWELS' })
    b.buy('2024-01-01', '3', 1000, 1, { description: 'WIDGET XL' })
    b.ret({ itemNumber: '9', description: 'KS DOG FOOD' }) // not purchased in data: not part of spend
    const s = buildAnalyticsSnapshot(b.build())
    const c = s.categories
    expect(c.categories.reduce((t, x) => t + x.spendCents, 0)).toBe(s.spending.lifetime.grossCents)
    expect(c.uncategorized).toMatchObject({ itemCount: 1, spendCents: 1000 })
    expect(c.uncategorized.spendShare).toBeCloseTo(0.2, 12)
    const grocery = c.categories.find((x) => x.categoryId === 'grocery')!
    expect(grocery.subcategories).toEqual([expect.objectContaining({ subcategoryId: 'produce', label: 'Produce', spendCents: 1000 })])
    expect(c.bySource).toEqual({ override: 0, rule: 2, fallback: 1 })
  })
})
