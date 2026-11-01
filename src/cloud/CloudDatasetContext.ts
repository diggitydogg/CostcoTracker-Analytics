import { createContext, useContext } from 'react'
import type { CloudDataset } from './cloudDataset'

/**
 * In-memory session cache of the owner's cloud dataset for the dashboard.
 *
 * Mounted once inside the signed-in cloud app, so switching between cloud
 * tabs never re-downloads the dataset. It is memory only: nothing is
 * persisted, and signing out unmounts it and drops the data.
 *
 * - `ensureLoaded()` fetches only if nothing has been loaded or requested yet.
 * - `reload()` always fetches fresh data from D1 (one meta request plus one
 *   request per page; it never touches the iPhone/Costco refresh workflow).
 * - `markStale()` / `noteChangeSeq()` record that the cloud changed after the
 *   loaded copy (a web import finished, or another screen saw a newer
 *   `changeSeq`). The dashboard then offers a reload; it never refetches by itself.
 */
export type CloudDatasetState = {
  dataset: CloudDataset | null
  loading: boolean
  error: string | null
  /** Browser time the current copy finished loading. */
  loadedAt: Date | null
  /** True when the cloud is known to have changed since `dataset` was loaded. */
  stale: boolean
}

export type CloudDatasetValue = CloudDatasetState & {
  ensureLoaded: () => void
  reload: () => void
  markStale: () => void
  noteChangeSeq: (changeSeq: number) => void
}

export const CloudDatasetContext = createContext<CloudDatasetValue | null>(null)

/** The dataset cache, or null outside a provider (screens then simply skip staleness reporting). */
export function useCloudDataset(): CloudDatasetValue | null {
  return useContext(CloudDatasetContext)
}
