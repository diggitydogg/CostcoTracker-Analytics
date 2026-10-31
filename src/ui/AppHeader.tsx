import { useState } from 'react'
import type { StorageState } from '../app/useDatasetController'

type Props = {
  storage: StorageState
  hasDataset: boolean
  hasLocalData: boolean
  busy: boolean
  onForget: () => Promise<void>
}

function storageLabel(storage: StorageState, hasDataset: boolean): string | null {
  switch (storage.kind) {
    case 'checking':
      return null
    case 'saved':
      return 'Saved on this device'
    case 'memory-only':
      return hasDataset ? 'In this tab only (not saved)' : null
    case 'corrupt':
      return 'Saved data needs attention'
    case 'unavailable':
      return hasDataset ? 'In this tab only (storage unavailable)' : null
  }
}

export function AppHeader({ storage, hasDataset, hasLocalData, busy, onForget }: Props) {
  const [confirming, setConfirming] = useState(false)
  const label = storageLabel(storage, hasDataset)

  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
        <h2 className="text-base font-semibold tracking-tight">File on this device</h2>
        {label && (
          <span
            data-testid="storage-status"
            className={
              'rounded-full px-2.5 py-0.5 text-xs font-medium ' +
              (storage.kind === 'saved'
                ? 'bg-emerald-100 text-emerald-900'
                : storage.kind === 'corrupt'
                  ? 'bg-red-100 text-red-900'
                  : 'bg-slate-100 text-slate-700')
            }
          >
            {label}
          </span>
        )}
        {hasLocalData && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {confirming ? (
              <>
                <span className="text-sm text-slate-700">Remove the imported dataset from this browser?</span>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                  onClick={async () => {
                    await onForget()
                    setConfirming(false)
                  }}
                >
                  Yes, forget it
                </button>
                <button
                  type="button"
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-50 disabled:opacity-50"
                onClick={() => setConfirming(true)}
              >
                Forget imported data
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
