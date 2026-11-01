/**
 * The app's single on-device IndexedDB database. Every locally persisted
 * piece of data lives here, so deleting the database ("Forget imported data")
 * removes all of it.
 *
 * - `dataset`: the imported export file (datasetStore.ts).
 * - `settings`: small user settings such as category overrides (overridesStore.ts).
 */
export const DB_NAME = 'costcotracker-analytics'
/** v1: dataset. v2: adds settings. Upgrades only ever add stores. */
export const DB_VERSION = 2
export const DATASET_STORE = 'dataset'
export const SETTINGS_STORE = 'settings'

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
  })
}

export function openAppDb(factory: IDBFactory | null): Promise<IDBDatabase> {
  if (!factory) return Promise.reject(new Error('IndexedDB is not available'))
  const request = factory.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const db = request.result
    for (const name of [DATASET_STORE, SETTINGS_STORE]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
  }
  return requestToPromise(request)
}

/** Runs one request in its own transaction and always closes the connection. */
export async function withAppStore<T>(
  factory: IDBFactory | null,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openAppDb(factory)
  try {
    const tx = db.transaction(storeName, mode)
    const result = requestToPromise(run(tx.objectStore(storeName)))
    await transactionDone(tx)
    return await result
  } finally {
    // Always close so a later deleteDatabase is never blocked by us.
    db.close()
  }
}
