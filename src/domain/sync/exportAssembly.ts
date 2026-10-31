import { EXPORT_FORMAT, FORMAT_VERSION_V1, type Item, type PriceAdjustment, type Receipt, type Return } from '../export/v1'
import { importExportValue, type ImportResult } from '../import/importExport'

export type CloudExportMeta = { exportedAt: string; currency: string | null }
export type CloudExportCollections = {
  receipts: Receipt[]
  items: Item[]
  returns: Return[]
  priceAdjustments: PriceAdjustment[]
}

/**
 * Builds an Export V1 file from paginated cloud export pages and validates it
 * with the same importer used for local files, so every backup is proven to
 * re-import before it is offered for download.
 */
export function assembleExportV1(
  meta: CloudExportMeta,
  collections: CloudExportCollections,
): { file: Record<string, unknown>; validation: ImportResult } {
  const file = {
    format: EXPORT_FORMAT,
    formatVersion: FORMAT_VERSION_V1,
    exportedAt: meta.exportedAt,
    // An empty instance has no currency yet; USD is the only currency the iOS app produces.
    currency: meta.currency ?? 'USD',
    receipts: collections.receipts,
    items: collections.items,
    returns: collections.returns,
    priceAdjustments: collections.priceAdjustments,
  }
  return { file, validation: importExportValue(structuredClone(file)) }
}
