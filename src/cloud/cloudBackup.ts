/**
 * Downloads everything the cloud holds through the paginated export endpoints,
 * reassembles an Export V1 file, and validates it with the same importer used
 * for local files. A backup is only offered if it would re-import cleanly.
 */
import type { Item, PriceAdjustment, Receipt, Return } from '../domain/export/v1'
import type { ImportError } from '../domain/import/importExport'
import { assembleExportV1 } from '../domain/sync/exportAssembly'
import type { CloudApi, ExportCollectionName, ExportMeta, ExportPage } from './api'

export type BackupProgress = { fetched: number; total: number; collection: ExportCollectionName | null }

export type CloudBackup = {
  fileName: string
  json: string
  counts: { receipts: number; items: number; returns: number; priceAdjustments: number }
  meta: ExportMeta
}

export class BackupInvalidError extends Error {
  constructor(readonly importError: ImportError) {
    super('The downloaded cloud data did not pass validation, so no backup file was created.')
    this.name = 'BackupInvalidError'
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

export async function createCloudBackup(
  api: CloudApi,
  options: { onProgress?: (p: BackupProgress) => void; pageSize?: number } = {},
): Promise<CloudBackup> {
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
  if (!validation.ok) throw new BackupInvalidError(validation.error)

  return {
    fileName: `costcotracker-analytics-backup-${meta.exportedAt.slice(0, 10)}.json`,
    json: JSON.stringify(file, null, 2),
    counts: {
      receipts: out.receipts.length,
      items: out.items.length,
      returns: out.returns.length,
      priceAdjustments: out.priceAdjustments.length,
    },
    meta,
  }
}

/** Saves text as a file via a temporary object URL (no network involved). */
export function saveTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after the click has been processed.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
