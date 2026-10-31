import type { AnalyticsExportV1, ReceiptSourceType } from './export/v1'

/**
 * Record counts for the post-import summary. These are plain counts of rows in
 * the file — not spending analytics — so a user can confirm the import matches
 * what they exported. Each count is reproducible by filtering the source rows.
 */
export type ImportSummary = {
  receiptCount: number
  receiptCountBySource: Record<ReceiptSourceType, number>
  itemCount: number
  returnCount: number
  priceAdjustmentCount: number
  /** Earliest/latest purchase date present, or null if no receipt has a date. */
  purchaseDateRange: { first: string; last: string } | null
  receiptsWithoutDate: number
}

export function summarizeImport(data: AnalyticsExportV1): ImportSummary {
  const bySource: Record<ReceiptSourceType, number> = { warehouse: 0, online: 0, synthetic: 0 }
  let first: string | null = null
  let last: string | null = null
  let withoutDate = 0

  for (const receipt of data.receipts) {
    bySource[receipt.sourceType] += 1
    const date = receipt.purchaseDate
    if (date === null) {
      withoutDate += 1
      continue
    }
    // YYYY-MM-DD strings sort lexicographically in calendar order; no Date objects needed.
    if (first === null || date < first) first = date
    if (last === null || date > last) last = date
  }

  return {
    receiptCount: data.receipts.length,
    receiptCountBySource: bySource,
    itemCount: data.items.length,
    returnCount: data.returns.length,
    priceAdjustmentCount: data.priceAdjustments.length,
    purchaseDateRange: first !== null && last !== null ? { first, last } : null,
    receiptsWithoutDate: withoutDate,
  }
}
