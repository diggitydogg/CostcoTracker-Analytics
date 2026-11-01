/**
 * Category spend by calendar year, for trend views.
 *
 * Uses each item's category assignment from the snapshot (overrides included)
 * and attributes every dated item line to its receipt's year. Undated lines are
 * reported separately, so for every category Σ years + undated = its lifetime
 * spend in `computeCategories`.
 */
import type { CategoryId } from './taxonomy'
import type { ItemAnalytics } from '../items'
import type { AnalyticsIndex } from '../model'
import { ratio } from '../stats'

export type CategoryYearCell = { spendCents: number; share: number | null; lineIds: string[] }

export type CategoryTrends = {
  years: number[]
  /** Gross spend per year (dated lines), the denominator of each share. */
  yearTotals: number[]
  rows: { categoryId: CategoryId; byYear: CategoryYearCell[]; undatedCents: number }[]
}

export function categoryTrends(index: AnalyticsIndex, items: ItemAnalytics): CategoryTrends {
  const years = [...new Set(index.lines.filter((l) => l.year !== null).map((l) => l.year!))].sort((a, b) => a - b)
  const yearPos = new Map(years.map((y, i) => [y, i]))
  const yearTotals = years.map(() => 0)
  const rows = new Map<CategoryId, { byYear: { spendCents: number; lineIds: string[] }[]; undatedCents: number }>()
  for (const line of index.lines) {
    const categoryId = items.byItemNumber.get(line.itemNumber)!.category.categoryId
    let row = rows.get(categoryId)
    if (!row) rows.set(categoryId, (row = { byYear: years.map(() => ({ spendCents: 0, lineIds: [] })), undatedCents: 0 }))
    if (line.year === null) {
      row.undatedCents += line.lineTotalCents
      continue
    }
    const i = yearPos.get(line.year)!
    row.byYear[i]!.spendCents += line.lineTotalCents
    row.byYear[i]!.lineIds.push(line.id)
    yearTotals[i]! += line.lineTotalCents
  }
  return {
    years,
    yearTotals,
    rows: [...rows.entries()]
      .map(([categoryId, r]) => ({
        categoryId,
        undatedCents: r.undatedCents,
        byYear: r.byYear.map((c, i) => ({ ...c, share: yearTotals[i]! > 0 ? ratio(c.spendCents, yearTotals[i]!) : null })),
      }))
      .sort((a, b) => sumOf(b) - sumOf(a) || (a.categoryId < b.categoryId ? -1 : 1)),
  }
}

const sumOf = (r: { byYear: { spendCents: number }[]; undatedCents: number }) => r.byYear.reduce((s, c) => s + c.spendCents, 0) + r.undatedCents
