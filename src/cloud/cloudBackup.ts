/**
 * Downloads everything the cloud holds through the paginated export endpoints,
 * reassembles an Export V1 file, and validates it with the same importer used
 * for local files. A backup is only offered if it would re-import cleanly.
 */
import type { ImportError } from '../domain/import/importExport'
import type { CloudApi, ExportMeta } from './api'
import { CloudDatasetInvalidError, fetchCloudDataset, type DatasetProgress } from './cloudDataset'

export type BackupProgress = DatasetProgress

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

export async function createCloudBackup(
  api: CloudApi,
  options: { onProgress?: (p: BackupProgress) => void; pageSize?: number } = {},
): Promise<CloudBackup> {
  let dataset
  try {
    dataset = await fetchCloudDataset(api, options)
  } catch (e) {
    if (e instanceof CloudDatasetInvalidError) throw new BackupInvalidError(e.importError)
    throw e
  }
  const { file, meta, data } = dataset
  const out = { receipts: data.receipts, items: data.items, returns: data.returns, priceAdjustments: data.priceAdjustments }

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
