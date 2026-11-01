/**
 * Loads the complete cloud dataset as one validated Analytics Export V1 value,
 * through the existing owner-only paginated export endpoints:
 * GET /api/export/meta, then GET /api/export/{receipts|items|returns|priceAdjustments}
 * page by page (one request per page; never per record). Tombstoned records
 * (no longer on the iPhone) are excluded by the server, as for backups.
 *
 * The pages are reassembled and validated by the same importer used for local
 * files, so cloud and local data reach the analytics engine in exactly the
 * same shape.
 */
import type { AnalyticsExportV1, Item, PriceAdjustment, Receipt, Return } from '../domain/export/v1'
import type { ImportError } from '../domain/import/importExport'
import { assembleExportV1 } from '../domain/sync/exportAssembly'
import type { CloudApi, ExportCollectionName, ExportMeta, ExportPage } from './api'

export type DatasetProgress = { fetched: number; total: number; collection: ExportCollectionName | null }

export class CloudDatasetInvalidError extends Error {
  constructor(readonly importError: ImportError) {
    super('The downloaded cloud data did not pass validation.')
    this.name = 'CloudDatasetInvalidError'
  }
}

const COLLECTIONS: ExportCollectionName[] = ['receipts', 'items', 'returns', 'priceAdjustments']

async function fetchAll<C extends ExportCollectionName>(
  api: CloudApi,
  collection: C,
  onRecords: (n: number) => void,
  pageSize: number,
) {
  const records: unknown[] = []
  let after: string | null = null
  do {
    const page: ExportPage<C> = await api.exportPage(collection, after, pageSize)
    for (const row of page.records) records.push(row.record)
    onRecords(page.records.length)
    after = page.nextCursor
  } while (after !== null)
  return records
}

export type CloudDataset = {
  data: AnalyticsExportV1
  /** The assembled Export V1 file (what a backup saves). */
  file: Record<string, unknown>
  meta: ExportMeta
}

export async function fetchCloudDataset(
  api: CloudApi,
  options: { onProgress?: (p: DatasetProgress) => void; pageSize?: number } = {},
): Promise<CloudDataset> {
  const pageSize = options.pageSize ?? 1000
  const meta = await api.exportMeta()
  const total = meta.counts.receipts + meta.counts.items + meta.counts.returns + meta.counts.priceAdjustments
  let fetched = 0
  options.onProgress?.({ fetched, total, collection: null })

  const out: Record<ExportCollectionName, unknown[]> = { receipts: [], items: [], returns: [], priceAdjustments: [] }
  for (const collection of COLLECTIONS) {
    out[collection] = await fetchAll(
      api,
      collection,
      (n) => {
        fetched += n
        options.onProgress?.({ fetched, total, collection })
      },
      pageSize,
    )
  }

  const { file, validation } = assembleExportV1(meta, {
    receipts: out.receipts as Receipt[],
    items: out.items as Item[],
    returns: out.returns as Return[],
    priceAdjustments: out.priceAdjustments as PriceAdjustment[],
  })
  if (!validation.ok) throw new CloudDatasetInvalidError(validation.error)
  return { data: validation.data, file, meta }
}
