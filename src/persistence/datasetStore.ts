/**
 * Optional on-device persistence for the imported dataset (IndexedDB).
 *
 * - Nothing is stored unless the user opts in.
 * - Exactly one dataset is kept, under a fixed key.
 * - `forgetLocalData()` deletes the whole app database (appDb.ts), so other
 *   on-device settings such as category overrides are removed too.
 * - Saved data is re-validated with the same importer on load; a corrupt or
 *   outdated record is reported, never silently patched.
 *
 * Minimal hand-written wrapper rather than a library: the app needs three
 * operations, and an injectable `IDBFactory` keeps it testable.
 */
import { z } from 'zod'
import type { LoadedDataset } from '../domain/dataset'
import { importExportValue, type ImportWarning } from '../domain/import/importExport'
import { DATASET_STORE, DB_NAME, withAppStore } from './appDb'

export { DB_NAME } from './appDb'

const CURRENT_KEY = 'current'
/** Version of the stored record layout (independent of the export format version). */
export const STORAGE_RECORD_VERSION = 1

type StoredRecord = {
  storageVersion: typeof STORAGE_RECORD_VERSION
  savedAt: string
  meta: LoadedDataset['meta']
  warnings: ImportWarning[]
  /** The validated export in V1 contract shape; re-validated on load. */
  export: LoadedDataset['data']
}

const storedRecordSchema = z.object({
  storageVersion: z.literal(STORAGE_RECORD_VERSION),
  savedAt: z.string(),
  meta: z.object({
    importedAt: z.string(),
    sourceLabel: z.string(),
    isSyntheticDemo: z.boolean(),
  }),
  warnings: z.array(
    z.object({
      kind: z.literal('unknown-fields'),
      location: z.string(),
      fields: z.array(z.string()),
      recordCount: z.number(),
    }),
  ),
  export: z.unknown(),
})

export type LoadSavedResult =
  | { status: 'none' }
  | { status: 'loaded'; dataset: LoadedDataset; savedAt: string }
  | { status: 'corrupt'; message: string }
  | { status: 'unavailable'; message: string }

export type DatasetStore = {
  isAvailable(): boolean
  save(dataset: LoadedDataset): Promise<void>
  load(): Promise<LoadSavedResult>
  /** Removes every piece of locally persisted data for this app. */
  forgetLocalData(): Promise<void>
}

/**
 * @param factory IndexedDB implementation; defaults to the browser's. Pass
 *   `null` to model a browser without IndexedDB.
 */
export function createDatasetStore(
  factory: IDBFactory | null = globalThis.indexedDB ?? null,
): DatasetStore {
  const withStore = <T,>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) =>
    withAppStore(factory, DATASET_STORE, mode, run)

  return {
    isAvailable: () => factory !== null,

    async save(dataset) {
      const record: StoredRecord = {
        storageVersion: STORAGE_RECORD_VERSION,
        savedAt: new Date().toISOString(),
        meta: dataset.meta,
        warnings: dataset.warnings,
        export: dataset.data,
      }
      await withStore('readwrite', (store) => store.put(record, CURRENT_KEY))
    },

    async load() {
      if (!factory) return { status: 'unavailable', message: 'This browser does not support on-device storage.' }
      let raw: unknown
      try {
        raw = await withStore('readonly', (store) => store.get(CURRENT_KEY))
      } catch {
        return {
          status: 'unavailable',
          message: 'On-device storage could not be read. Private browsing modes may block it.',
        }
      }
      if (raw === undefined) return { status: 'none' }

      const record = storedRecordSchema.safeParse(raw)
      if (!record.success) {
        return {
          status: 'corrupt',
          message: 'The saved dataset on this device is from an incompatible version or is damaged.',
        }
      }
      const validated = importExportValue(record.data.export)
      if (!validated.ok) {
        return {
          status: 'corrupt',
          message: `The saved dataset on this device failed validation: ${validated.error.message}`,
        }
      }
      return {
        status: 'loaded',
        savedAt: record.data.savedAt,
        dataset: { data: validated.data, warnings: record.data.warnings, meta: record.data.meta },
      }
    },

    async forgetLocalData() {
      if (!factory) return
      await new Promise<void>((resolve, reject) => {
        const request = factory.deleteDatabase(DB_NAME)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error ?? new Error('Could not delete local data'))
        // `blocked` only delays deletion until other tabs close their connection;
        // success still fires afterwards, so there is nothing to do here.
      })
    },
  }
}
