import { useId, useRef, useState } from 'react'
import type { DatasetController } from '../app/useDatasetController'
import { EXPORT_FORMAT, FORMAT_VERSION_V1 } from '../domain/export/v1'
import { ImportErrorPanel } from './ImportErrorPanel'

type Props = {
  controller: DatasetController
  onImported: () => void
  /** Present when a dataset is already loaded and the user can go back to it. */
  onCancel: (() => void) | undefined
}

export function ImportScreen({ controller, onImported, onCancel }: Props) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [remember, setRemember] = useState(false)
  const [dragging, setDragging] = useState(false)

  async function handleFile(file: File | undefined) {
    if (!file) return
    const ok = await controller.importFile(file, remember && controller.canRemember)
    if (inputRef.current) inputRef.current.value = ''
    if (ok) onImported()
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section>
        <h2 className="text-2xl font-semibold tracking-tight">Import your CostcoTracker export</h2>
        <p className="mt-2 text-slate-700">
          In the CostcoTracker iOS app, export your analytics data as a <code>.json</code> file, then choose it here.
          The file is read and validated in this browser; nothing is uploaded.
        </p>
      </section>

      <div
        data-testid="drop-zone"
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void handleFile(e.dataTransfer.files[0])
        }}
        className={
          'rounded-xl border-2 border-dashed p-6 text-center transition-colors sm:p-10 ' +
          (dragging ? 'border-sky-500 bg-sky-50' : 'border-slate-300 bg-white')
        }
      >
        <p className="text-slate-700">Drag and drop the export file here, or</p>
        <label
          htmlFor={inputId}
          className="mt-3 inline-block cursor-pointer rounded-md bg-sky-700 px-4 py-2 font-medium text-white hover:bg-sky-800 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sky-600"
        >
          Choose export file
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            disabled={controller.busy}
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
        </label>
        <p className="mt-3 text-xs text-slate-500">
          Expected: <code>"format": "{EXPORT_FORMAT}"</code>, <code>"formatVersion": {FORMAT_VERSION_V1}</code>
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={remember && controller.canRemember}
            disabled={!controller.canRemember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>
            <span className="font-medium">Remember this dataset on this device</span>
            <span className="block text-sm text-slate-600">
              {controller.canRemember
                ? 'Stores the imported data in this browser (IndexedDB) so it is still here next time. Only one dataset is kept; importing replaces it. You can remove it at any time with “Forget imported data”.'
                : 'On-device storage is not available in this browser, so the dataset will only be kept while this tab is open.'}
            </span>
          </span>
        </label>
      </div>

      {controller.busy && (
        <p role="status" className="text-sm text-slate-600">
          Reading and validating…
        </p>
      )}

      {controller.importError && (
        <ImportErrorPanel error={controller.importError} onDismiss={controller.dismissError} />
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          disabled={controller.busy}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-100 disabled:opacity-50"
          onClick={async () => {
            if (await controller.importDemo(remember && controller.canRemember)) onImported()
          }}
        >
          Try with synthetic demo data
        </button>
        {onCancel && (
          <button type="button" className="rounded-md px-3 py-1.5 underline hover:bg-slate-100" onClick={onCancel}>
            Back to current dataset
          </button>
        )}
      </div>
    </div>
  )
}
