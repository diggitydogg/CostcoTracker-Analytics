/**
 * Category taxonomy. Pure data: no rules, no analytics.
 * IDs are stable keys (safe to store in overrides); labels are for display.
 */
export const CATEGORIES = [
  {
    id: 'grocery',
    label: 'Grocery',
    subcategories: [
      { id: 'produce', label: 'Produce' },
      { id: 'meat-seafood', label: 'Meat & Seafood' },
      { id: 'dairy-eggs', label: 'Dairy & Eggs' },
      { id: 'frozen', label: 'Frozen' },
      { id: 'snacks', label: 'Snacks' },
      { id: 'beverages', label: 'Beverages' },
      { id: 'pantry', label: 'Pantry' },
      { id: 'bakery', label: 'Bakery' },
    ],
  },
  { id: 'household', label: 'Household', subcategories: [] },
  { id: 'cleaning', label: 'Cleaning', subcategories: [] },
  { id: 'paper-goods', label: 'Paper Goods', subcategories: [] },
  { id: 'personal-care', label: 'Personal Care', subcategories: [] },
  { id: 'health', label: 'Health', subcategories: [] },
  { id: 'clothing', label: 'Clothing', subcategories: [] },
  { id: 'electronics', label: 'Electronics', subcategories: [] },
  { id: 'home', label: 'Home', subcategories: [] },
  { id: 'seasonal', label: 'Seasonal', subcategories: [] },
  { id: 'automotive', label: 'Automotive', subcategories: [] },
  { id: 'pet', label: 'Pet', subcategories: [] },
  { id: 'alcohol', label: 'Alcohol', subcategories: [] },
  { id: 'other', label: 'Other', subcategories: [] },
  { id: 'uncategorized', label: 'Uncategorized', subcategories: [] },
] as const

export type CategoryId = (typeof CATEGORIES)[number]['id']
export type GrocerySubcategoryId = (typeof CATEGORIES)[0]['subcategories'][number]['id']
export type SubcategoryId = GrocerySubcategoryId

export const UNCATEGORIZED: CategoryId = 'uncategorized'

export const CATEGORY_IDS: readonly CategoryId[] = CATEGORIES.map((c) => c.id)

export function categoryLabel(id: CategoryId): string {
  return CATEGORIES.find((c) => c.id === id)!.label
}

export function subcategoryLabel(category: CategoryId, sub: string | null): string | null {
  if (sub === null) return null
  const c = CATEGORIES.find((x) => x.id === category)
  return (c?.subcategories as readonly { id: string; label: string }[] | undefined)?.find((s) => s.id === sub)?.label ?? null
}

export function isValidAssignment(category: string, sub: string | null | undefined): category is CategoryId {
  const c = CATEGORIES.find((x) => x.id === category)
  if (!c) return false
  if (sub === null || sub === undefined) return true
  return (c.subcategories as readonly { id: string }[]).some((s) => s.id === sub)
}
