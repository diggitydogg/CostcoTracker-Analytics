/**
 * Data quality and coverage: everything that materially affects how the
 * analytics should be read. Counts only — never purchase values beyond
 * aggregate spend shares.
 */
import type { AdjustmentAnalytics } from './adjustments'
import type { CategoryAnalytics } from './categories/analytics'
import type { InflationAnalytics, InflationConfidence } from './inflation'
import type { ReturnAnalytics } from './returns'
import type { AnalyticsIndex } from './model'
import { ratio } from './stats'
import type { WarehouseAnalytics } from './warehouses'

/** Optional facts about where the dataset came from. */
export type DatasetSourceInfo = {
  source: 'cloud' | 'local-file'
  /** Cloud records no longer on the iPhone (tombstoned) and therefore not included. */
  excludedTombstonedRecords?: number
}

export type CountWithIds = { count: number; ids: string[] }

export type DataQuality = {
  source: DatasetSourceInfo | null
  totals: { receipts: number; itemLines: number; returns: number; priceAdjustments: number }
  firstDate: string | null
  lastDate: string | null
  asOf: string | null
  receiptsWithoutDate: CountWithIds
  itemLinesWithoutDate: { count: number; spendCents: number }
  receiptsWithoutItems: CountWithIds
  itemLinesWithoutUnitPrice: { count: number; spendCents: number; spendShare: number | null }
  returnsWithoutAmount: CountWithIds
  returnsWithoutDate: CountWithIds
  adjustmentsWithoutDate: CountWithIds
  receiptsBySource: { warehouse: number; online: number; synthetic: number }
  /** Receipts keyed by a synthesized WHSE_ key (no barcode); same-day trips may be merged. */
  synthesizedWarehouseKeyReceipts: number
  placeholderWarehouseReceipts: number
  unknownWarehouseReceipts: number
  uncategorized: { itemCount: number; itemShare: number | null; spendCents: number; spendShare: number | null }
  itemsWithReturnsExceedingPurchases: string[]
  inflation: {
    eligibleItems: number
    yearlyLinksByConfidence: Record<InflationConfidence, number>
    monthlyLinksByConfidence: Record<InflationConfidence, number>
    latestYearConfidence: InflationConfidence | null
  }
  /** Plain-language notes on limitations that apply to THIS dataset. */
  limitations: string[]
}

export function computeQuality(
  index: AnalyticsIndex,
  grossCents: number,
  categories: CategoryAnalytics,
  returns: ReturnAnalytics,
  adjustments: AdjustmentAnalytics,
  inflation: InflationAnalytics,
  warehouses: WarehouseAnalytics,
  source: DatasetSourceInfo | null,
): DataQuality {
  const ids = <T extends { id: string }>(xs: T[]): CountWithIds => ({ count: xs.length, ids: xs.map((x) => x.id) })
  const undatedEvents = index.events.filter((e) => e.date === null)
  const undatedLines = index.lines.filter((l) => l.date === null)
  const unpriced = index.lines.filter((l) => l.unitPriceCents === null)
  const unpricedSpend = unpriced.reduce((s, l) => s + l.lineTotalCents, 0)
  const dates = index.events.map((e) => e.date).filter((d): d is string => d !== null).sort()
  const purchasedItems = categories.categories.reduce((s, c) => s + c.itemNumbers.length, 0)
  const bySource = { warehouse: 0, online: 0, synthetic: 0 }
  for (const e of index.events) bySource[e.sourceType] += 1
  const countKind = (kind: string) => warehouses.groups.filter((g) => g.kind === kind).reduce((s, g) => s + g.events, 0)
  const whse = index.events.filter((e) => e.identifierKind === 'synthesizedWarehouseKey').length

  const quality: DataQuality = {
    source,
    totals: {
      receipts: index.events.length,
      itemLines: index.lines.length,
      returns: index.returns.length,
      priceAdjustments: index.adjustments.length,
    },
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    asOf: index.asOf,
    receiptsWithoutDate: ids(undatedEvents),
    itemLinesWithoutDate: { count: undatedLines.length, spendCents: undatedLines.reduce((s, l) => s + l.lineTotalCents, 0) },
    receiptsWithoutItems: ids(index.events.filter((e) => e.lineCount === 0)),
    itemLinesWithoutUnitPrice: { count: unpriced.length, spendCents: unpricedSpend, spendShare: grossCents > 0 ? ratio(unpricedSpend, grossCents) : null },
    returnsWithoutAmount: ids(index.returns.filter((r) => r.merchandiseAmountCents === null)),
    returnsWithoutDate: ids(index.returns.filter((r) => r.returnDate === null)),
    adjustmentsWithoutDate: ids(index.adjustments.filter((a) => a.adjustmentDate === null)),
    receiptsBySource: bySource,
    synthesizedWarehouseKeyReceipts: whse,
    placeholderWarehouseReceipts: countKind('placeholder'),
    unknownWarehouseReceipts: countKind('unknown'),
    uncategorized: {
      itemCount: categories.uncategorized.itemCount,
      itemShare: purchasedItems > 0 ? ratio(categories.uncategorized.itemCount, purchasedItems) : null,
      spendCents: categories.uncategorized.spendCents,
      spendShare: categories.uncategorized.spendShare,
    },
    itemsWithReturnsExceedingPurchases: returns.items.filter((r) => r.returnsExceedPurchases).map((r) => r.itemNumber),
    inflation: {
      eligibleItems: inflation.eligibleItems,
      yearlyLinksByConfidence: inflation.yearly.linksByConfidence,
      monthlyLinksByConfidence: inflation.monthly.linksByConfidence,
      latestYearConfidence: inflation.summary.latestYearConfidence,
    },
    limitations: [],
  }

  const notes = quality.limitations
  notes.push('Spending is merchandise only: the export has no tax or receipt totals, so baskets are estimated from item line totals (net of instant savings).')
  if (quality.receiptsWithoutDate.count > 0) {
    notes.push(`${quality.receiptsWithoutDate.count} receipt(s) have no purchase date; their spend counts toward lifetime totals but not toward any month or year.`)
  }
  if (quality.itemLinesWithoutUnitPrice.count > 0) {
    notes.push(`${quality.itemLinesWithoutUnitPrice.count} item line(s) have no recorded unit price and are left out of price history and inflation (never estimated).`)
  }
  if (quality.returnsWithoutAmount.count > 0) {
    notes.push(`${quality.returnsWithoutAmount.count} return(s) have no recorded merchandise amount and are not included in refund dollars.`)
  }
  if (whse > 0) {
    notes.push(`${whse} warehouse receipt(s) had no barcode; same-day trips to one warehouse may have been merged, so trip counts are a lower bound.`)
  }
  if (quality.placeholderWarehouseReceipts + quality.unknownWarehouseReceipts > 0) {
    notes.push('Some receipts have no warehouse name recorded and are grouped as "Unknown warehouse".')
  }
  if (bySource.synthetic > 0) notes.push(`${bySource.synthetic} synthetic (test/demo) receipt(s) are included.`)
  if (quality.itemsWithReturnsExceedingPurchases.length > 0) {
    notes.push(`${quality.itemsWithReturnsExceedingPurchases.length} item(s) were returned in larger quantities than purchased in this data (purchases from before the data begins).`)
  }
  if (!returns.purchaseLinkedReturnRate.available || !adjustments.purchaseLinkedSavingsRate.available) {
    notes.push('Returns and price adjustments are matched to items by item number only; they are not linked to a specific purchase. Return and adjustment figures are shown as a share of observed spend, not as true return or savings rates.')
  }
  const conf = inflation.summary.latestYearConfidence
  if (conf === null || conf === 'insufficient') notes.push('There is not enough repeat-price data for a meaningful personal inflation estimate.')
  else if (conf === 'low-coverage') notes.push('Personal inflation is shown, but the matched items cover too little of your spending to call it reliable.')
  if (source?.excludedTombstonedRecords) {
    notes.push(`${source.excludedTombstonedRecords} cloud record(s) no longer on the iPhone are kept as history but not included here.`)
  }
  return quality
}
