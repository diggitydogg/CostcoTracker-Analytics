// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from '../snapshot'
import { DatasetBuilder } from '../test/builder'
import { categorize, matchRules, parseCategoryOverrides, serializeCategoryOverrides, tokenize, withOverride } from './engine'
import { DEFAULT_RULES } from './rules'

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

/** Rules added after the real-data QA pass. Each has positives and negatives guarding against broad substrings. */
const qaCases: [string, string, string | null][] = [
  // Grocery
  ['STREET TACOS', 'grocery', null],
  ['CHICKEN STREET TACOS', 'grocery', 'meat-seafood'], // a more specific rule above still wins
  ['TACO SEASONING', 'grocery', 'pantry'], // "TACO" alone is not a prepared-food rule
  ['ORG MEDITERR', 'grocery', null],
  ['MEDITERRANEAN SEA SALT', 'grocery', 'pantry'],
  ['MEDITERRANEAN PATIO RUG', 'seasonal', null], // non-food rules come first
  ['POPCORNERS', 'grocery', 'snacks'],
  ['POPCORNERS KETTLE 28 CT', 'grocery', 'snacks'],
  ['SPINDRIFT', 'grocery', 'beverages'],
  ['SPINDRIFT LEMON 24 PK', 'grocery', 'beverages'],
  ['SPINDRIFT SPIKED 12 PK', 'alcohol', null], // hard seltzer, not a soft drink
  // Paper goods: the truncated receipt text only
  ['KS BATH', 'paper-goods', null],
  ['KS BATH TOWEL 2 PK', 'home', null],
  ['KS BATH SHEET', 'home', null],
  ['KS BATHROBE', 'uncategorized', null],
  // Home
  ['FAUCET', 'home', null],
  ['PFISTER KITCHEN FAUCET', 'home', null],
  ['PUR FAUCET FILTER 3 PK', 'household', null], // filters stay with household filters
  ['BISSELLMULTI', 'home', null],
  ['BISSELL CROSSWAVE', 'home', null],
  ['BISSELL CLEANING FORMULA', 'cleaning', null], // consumable cleaner stays in cleaning
  ['ZBEAMSHELVES', 'home', null],
  ['WIRE SHELVES 5 TIER', 'home', null],
  ['BOOKSHELVES', 'uncategorized', null], // whole tokens only
  // Seasonal (outdoor living, like PATIO)
  ['FIREPIT', 'seasonal', null],
  ['SOLO STOVE FIRE PIT', 'seasonal', null],
  ['FIREPLACE TOOL SET', 'uncategorized', null],
  // Health
  ['VITALPROTEIN', 'health', null],
  ['VITAL PROTEINS COLLAGEN', 'health', null],
  ['VITAL FARMS EGGS 24 CT', 'grocery', 'dairy-eggs'], // "VITAL" alone is not a rule
  // Electronics (the Anker false positive)
  ['Anker MagGo 3-in-1 Charging Station', 'electronics', null],
  ['ANKER POWER BANK 2 PK', 'electronics', null],
  ['BELKIN WIRELESS CHARGING PAD', 'electronics', null],
  ['MAGSAFE CASE', 'electronics', null],
  ['ANKLE SOCKS 10 PK', 'clothing', null], // "ANKER" is a whole token
]

describe('production QA rules', () => {
  it.each(qaCases)('%s → %s / %s', (description, category, sub) => {
    const a = categorize('1', [description])
    expect([a.categoryId, a.subcategoryId]).toEqual([category, sub])
  })

  it('anchored phrases match only at the start/end of the description', () => {
    expect(matchRules('KS BATH')?.phrase).toBe('^KS BATH$')
    expect(matchRules('NEW KS BATH')).toBeNull()
    expect(matchRules('KS BATH 30 ROLL')).toBeNull() // only the bare truncated text is anchored
    expect(matchRules('')).toBeNull()
    expect(matchRules('KS')).toBeNull() // shorter than the anchored phrase
  })

  it('the latest description decides before older variants with broad words', () => {
    // An older receipt/return variant containing a broad grocery word no longer wins,
    // because the latest description now matches the electronics rule first.
    expect(categorize('1', ['Anker MagGo 3-in-1 Charging Station', 'ANKER 3IN1 FOR APPLE'])).toMatchObject({
      categoryId: 'electronics',
      matchedPhrase: 'ANKER',
    })
  })

  it('every rule phrase is well formed and unique', () => {
    const seen = new Map<string, string>()
    for (const rule of DEFAULT_RULES) {
      for (const phrase of rule.phrases) {
        expect(phrase).toMatch(/^\^?[A-Z0-9]+\*?( [A-Z0-9]+\*?)*\$?$/)
        expect(seen.get(phrase), `${phrase} appears in ${seen.get(phrase)} and ${rule.id}`).toBeUndefined()
        seen.set(phrase, rule.id)
      }
    }
  })

  it('an override still beats the new rules', () => {
    expect(categorize('9', ['SPINDRIFT'], { '9': { categoryId: 'alcohol' } })).toMatchObject({ categoryId: 'alcohol', source: 'override' })
  })
})

describe('rules exposed by live product identification', () => {
  it('fixes the misfiled identified product names', () => {
    expect(matchRules('Kirkland Signature Chicken Tortilla Soup')).toMatchObject({ rule: { categoryId: 'grocery', subcategoryId: 'pantry' }, phrase: 'TORTILLA SOUP' })
    expect(matchRules('Yellow Nectarines')).toMatchObject({ rule: { subcategoryId: 'produce' } })
    expect(matchRules('APRICOTS 2 LB')).toMatchObject({ rule: { subcategoryId: 'produce' } })
    expect(matchRules("Mrs. Meyer's Clean Day Multi-Surface Spray, Lemon Verbena")).toMatchObject({ rule: { categoryId: 'cleaning' } })
    expect(matchRules('MULTISURFACE CLEANING SPRAY')).toMatchObject({ rule: { categoryId: 'cleaning' } })
  })

  it('leaves the neighbouring rules alone', () => {
    expect(matchRules('KS FLOUR TORTILLAS 30CT')).toMatchObject({ rule: { subcategoryId: 'bakery' } })
    expect(matchRules('TORTILLA CHIPS 3 LB')).toMatchObject({ rule: { subcategoryId: 'snacks' } })
    expect(matchRules("Mrs. Meyer's Clean Day Hand Soap Refill")).toMatchObject({ rule: { categoryId: 'personal-care' } })
    expect(matchRules('CHOC STRAWBERRIES')).toMatchObject({ rule: { subcategoryId: 'produce' } }) // receipt text alone: unchanged
  })

  it('a grocery item the identified name calls frozen is Frozen; receipt-only results never change', () => {
    // The receipt matched produce first; the identity says frozen.
    expect(categorize('1', ['CHOC STRAWBERRIES'], {}, DEFAULT_RULES, ['Kirkland Signature Frozen Dark Chocolate Strawberries'])).toMatchObject({
      categoryId: 'grocery',
      subcategoryId: 'frozen',
      source: 'rule',
      matchedPhrase: 'FROZEN',
      basis: 'identity',
    })
    // No receipt match, and the name's snack phrase comes first: still Frozen.
    expect(categorize('1', ['KS DIPPED STRAWB'], {}, DEFAULT_RULES, ['Kirkland Signature Frozen Dark Chocolate Strawberries'])).toMatchObject({ subcategoryId: 'frozen', basis: 'identity' })
    // Without an identity nothing changes.
    expect(categorize('1', ['CHOC STRAWBERRIES'])).toMatchObject({ subcategoryId: 'produce', basis: 'receipt' })
    // An identity that does not say frozen does not change the receipt result.
    expect(categorize('1', ['CHOC STRAWBERRIES'], {}, DEFAULT_RULES, ['Chocolate Covered Strawberries'])).toMatchObject({ subcategoryId: 'produce', basis: 'receipt' })
    // Non-grocery categories are never turned into Frozen (e.g. a "Frozen" themed toy or costume).
    expect(categorize('1', ['KIDS COSTUME'], {}, DEFAULT_RULES, ['Disney Frozen Elsa Costume'])).toMatchObject({ categoryId: 'seasonal' })
    // The owner's override still wins.
    expect(categorize('1', ['CHOC STRAWBERRIES'], { '1': { categoryId: 'grocery', subcategoryId: 'snacks' } }, DEFAULT_RULES, ['Frozen Strawberries'])).toMatchObject({ source: 'override', subcategoryId: 'snacks' })
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
