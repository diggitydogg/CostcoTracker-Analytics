/**
 * Category spend breakdown. Each item number has exactly one assignment
 * (override → rule → Uncategorized), so Σ category spend = gross spend.
 */
import type { ItemAnalytics } from '../items'
import { ratio } from '../stats'
import { CATEGORIES, categoryLabel, subcategoryLabel, type CategoryId } from './taxonomy'

export type SubcategorySpend = { subcategoryId: string | null; label: string; spendCents: number; quantity: number; itemNumbers: string[] }

export type CategorySpend = {
  categoryId: CategoryId
  label: string
  spendCents: number
  /** Share of gross purchase spend. */
  spendShare: number | null
  quantity: number
  lineCount: number
  itemNumbers: string[]
  subcategories: SubcategorySpend[]
  topItems: string[]
}

export type CategoryAnalytics = {
  categories: CategorySpend[]
  uncategorized: { itemCount: number; spendCents: number; spendShare: number | null; itemNumbers: string[] }
  bySource: Record<'override' | 'rule' | 'fallback', number>
}

export function computeCategories(items: ItemAnalytics, grossCents: number, topN: number): CategoryAnalytics {
  const purchased = items.items.filter((i) => i.purchaseEvents > 0)
  const categories: CategorySpend[] = CATEGORIES.map((c) => {
    const members = purchased.filter((i) => i.category.categoryId === c.id)
    const spend = members.reduce((s, i) => s + i.totalSpentCents, 0)
    const subs = new Map<string | null, SubcategorySpend>()
    for (const i of members) {
      const sub = i.category.subcategoryId
      const entry = subs.get(sub) ?? {
        subcategoryId: sub,
        label: subcategoryLabel(c.id, sub) ?? (sub === null ? 'General' : sub),
        spendCents: 0,
        quantity: 0,
        itemNumbers: [],
      }
      entry.spendCents += i.totalSpentCents
      entry.quantity = Math.round((entry.quantity + i.totalQuantity) * 1e6) / 1e6
      entry.itemNumbers.push(i.itemNumber)
      subs.set(sub, entry)
    }
    return {
      categoryId: c.id,
      label: categoryLabel(c.id),
      spendCents: spend,
      spendShare: grossCents > 0 ? ratio(spend, grossCents) : null,
      quantity: Math.round(members.reduce((s, i) => s + i.totalQuantity, 0) * 1e6) / 1e6,
      lineCount: members.reduce((s, i) => s + i.lineCount, 0),
      itemNumbers: members.map((i) => i.itemNumber),
      subcategories: [...subs.values()].sort((a, b) => b.spendCents - a.spendCents),
      topItems: [...members]
        .sort((a, b) => b.totalSpentCents - a.totalSpentCents || (a.itemNumber < b.itemNumber ? -1 : 1))
        .slice(0, topN)
        .map((i) => i.itemNumber),
    }
  })
  const unc = categories.find((c) => c.categoryId === 'uncategorized')!
  const bySource = { override: 0, rule: 0, fallback: 0 }
  for (const i of purchased) bySource[i.category.source] += 1
  return {
    categories: categories.filter((c) => c.itemNumbers.length > 0).sort((a, b) => b.spendCents - a.spendCents),
    uncategorized: { itemCount: unc.itemNumbers.length, spendCents: unc.spendCents, spendShare: unc.spendShare, itemNumbers: unc.itemNumbers },
    bySource,
  }
}
