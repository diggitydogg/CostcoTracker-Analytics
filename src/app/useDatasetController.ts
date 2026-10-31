import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoadedDataset } from '../domain/dataset'
import {
  MAX_IMPORT_BYTES,
  importExportText,
  importExportValue,
  tooLargeError,
  type ImportError,
} from '../domain/import/importExport'
import type { DatasetStore } from '../persistence/datasetStore'

export type StorageState =
  /** Still checking IndexedDB for a saved dataset. */
  | { kind: 'checking' }
  /** Current dataset (if any) lives only in this tab's memory. */
  | { kind: 'memory-only' }
  /** Current dataset is saved on this device. */
  | { kind: 'saved'; savedAt: string }
  /** A saved record exists but could not be used. */
  | { kind: 'corrupt'; message: string }
  /** IndexedDB is unavailable; remembering is not possible. */
  | { kind: 'unavailable'; message: string }

export type ControllerState = {
  dataset: LoadedDataset | null
  storage: StorageState
  importError: ImportError | null
  /** Non-blocking message, e.g. that saving failed. */
  notice: string | null
  busy: boolean
}

export type DatasetController = ControllerState & {
  /** Resolves true when the file was accepted. */
  importFile(file: File, remember: boolean): Promise<boolean>
  importDemo(remember: boolean): Promise<boolean>
  forget(): Promise<void>
  dismissError(): void
  /** True when the user may opt in to on-device storage. */
  canRemember: boolean
}

export function useDatasetController(store: DatasetStore): DatasetController {
  const [state, setState] = useState<ControllerState>({
    dataset: null,
    storage: store.isAvailable() ? { kind: 'checking' } : { kind: 'unavailable', message: 'This browser does not support on-device storage.' },
    importError: null,
    notice: null,
    busy: false,
  })
  // Guards against a slow initial load overwriting a dataset imported meanwhile.
  const generation = useRef(0)

  useEffect(() => {
    if (!store.isAvailable()) return
    const startedAt = generation.current
    let cancelled = false
    void store.load().then((result) => {
      if (cancelled || generation.current !== startedAt) return
      setState((s) => {
        switch (result.status) {
          case 'loaded':
            return { ...s, dataset: result.dataset, storage: { kind: 'saved', savedAt: result.savedAt } }
          case 'none':
            return { ...s, storage: { kind: 'memory-only' } }
          case 'corrupt':
            return { ...s, storage: { kind: 'corrupt', message: result.message } }
          case 'unavailable':
            return { ...s, storage: { kind: 'unavailable', message: result.message } }
        }
      })
    })
    return () => {
      cancelled = true
    }
  }, [store])

  const accept = useCallback(
    async (dataset: LoadedDataset, remember: boolean): Promise<boolean> => {
      generation.current += 1
      let storage: StorageState = { kind: 'memory-only' }
      let notice: string | null = null
      if (store.isAvailable()) {
        try {
          if (remember) {
            await store.save(dataset)
            storage = { kind: 'saved', savedAt: new Date().toISOString() }
          } else {
            // Only one dataset is kept: importing without "remember" must not
            // leave an older saved dataset behind on the device.
            await store.forgetLocalData()
          }
        } catch {
          notice = remember
            ? 'The dataset was imported but could not be saved on this device. It will be cleared when you close this tab.'
            : 'The dataset was imported, but a previously saved dataset could not be removed. Use "Forget imported data" to try again.'
        }
      } else {
        storage = { kind: 'unavailable', message: 'This browser does not support on-device storage.' }
        if (remember) notice = 'On-device storage is unavailable, so this dataset will be cleared when you close this tab.'
      }
      setState((s) => ({ ...s, dataset, storage, importError: null, notice, busy: false }))
      return true
    },
    [store],
  )

  const importFile = useCallback(
    async (file: File, remember: boolean): Promise<boolean> => {
      setState((s) => ({ ...s, busy: true, importError: null, notice: null }))
      if (file.size > MAX_IMPORT_BYTES) {
        setState((s) => ({ ...s, busy: false, importError: tooLargeError() }))
        return false
      }
      let text: string
      try {
        text = await file.text()
      } catch {
        setState((s) => ({
          ...s,
          busy: false,
          importError: {
            kind: 'unreadable',
            message: 'The file could not be read.',
            hint: 'Check that the file still exists and that the browser has permission to read it.',
            issues: [],
            totalIssueCount: 0,
          },
        }))
        return false
      }
      const result = importExportText(text)
      if (!result.ok) {
        setState((s) => ({ ...s, busy: false, importError: result.error }))
        return false
      }
      return accept(
        {
          data: result.data,
          warnings: result.warnings,
          meta: { importedAt: new Date().toISOString(), sourceLabel: file.name, isSyntheticDemo: false },
        },
        remember,
      )
    },
    [accept],
  )

  const importDemo = useCallback(
    async (remember: boolean): Promise<boolean> => {
      setState((s) => ({ ...s, busy: true, importError: null, notice: null }))
      // Lazy-loaded so the synthetic fixture is not part of the main bundle path.
      const fixture = (await import('../fixtures/synthetic-export-v1.json')).default
      const result = importExportValue(fixture)
      if (!result.ok) {
        setState((s) => ({ ...s, busy: false, importError: result.error }))
        return false
      }
      return accept(
        {
          data: result.data,
          warnings: result.warnings,
          meta: {
            importedAt: new Date().toISOString(),
            sourceLabel: 'Synthetic demo data',
            isSyntheticDemo: true,
          },
        },
        remember,
      )
    },
    [accept],
  )

  const forget = useCallback(async () => {
    generation.current += 1
    setState((s) => ({ ...s, busy: true }))
    let notice: string | null = null
    let storage: StorageState = { kind: 'memory-only' }
    if (store.isAvailable()) {
      try {
        await store.forgetLocalData()
      } catch {
        notice = 'Imported data was cleared from this tab, but on-device storage could not be deleted. Try again, or clear site data in your browser settings.'
        storage = { kind: 'corrupt', message: 'Saved data may still be present on this device.' }
      }
    } else {
      storage = { kind: 'unavailable', message: 'This browser does not support on-device storage.' }
    }
    setState({ dataset: null, storage, importError: null, notice, busy: false })
  }, [store])

  const dismissError = useCallback(() => setState((s) => ({ ...s, importError: null })), [])

  return {
    ...state,
    importFile,
    importDemo,
    forget,
    dismissError,
    canRemember: state.storage.kind !== 'unavailable',
  }
}
