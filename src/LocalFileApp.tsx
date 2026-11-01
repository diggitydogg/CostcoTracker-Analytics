import { useMemo, useState } from 'react'
import { useDatasetController } from './app/useDatasetController'
import { createDatasetStore, type DatasetStore } from './persistence/datasetStore'
import { AppHeader } from './ui/AppHeader'
import { DatasetShell } from './ui/DatasetShell'
import { ImportScreen } from './ui/ImportScreen'

/** The original local-only viewer: open an export file and keep it in this browser. */
export function LocalFileApp({ store }: { store?: DatasetStore }) {
  const datasetStore = useMemo(() => store ?? createDatasetStore(), [store])
  const controller = useDatasetController(datasetStore)
  const [showImport, setShowImport] = useState(false)

  const hasLocalData =
    controller.dataset !== null ||
    controller.storage.kind === 'saved' ||
    controller.storage.kind === 'corrupt'

  const showImportScreen = controller.dataset === null || showImport

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader
        storage={controller.storage}
        hasDataset={controller.dataset !== null}
        hasLocalData={hasLocalData}
        busy={controller.busy}
        onForget={async () => {
          await controller.forget()
          setShowImport(false)
        }}
      />
      <main className="mx-auto w-full max-w-[100rem] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {controller.notice && (
          <p role="status" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {controller.notice}
          </p>
        )}
        {controller.storage.kind === 'corrupt' && controller.dataset === null && (
          <p role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            {controller.storage.message} Use “Forget imported data” to remove it, then import a new file.
          </p>
        )}
        {controller.storage.kind === 'checking' ? (
          <p role="status" className="text-sm text-slate-600">
            Checking this device for a saved dataset…
          </p>
        ) : showImportScreen ? (
          <ImportScreen
            controller={controller}
            onCancel={controller.dataset !== null ? () => setShowImport(false) : undefined}
            onImported={() => setShowImport(false)}
          />
        ) : (
          controller.dataset && (
            <DatasetShell dataset={controller.dataset} onImportAnother={() => setShowImport(true)} />
          )
        )}
      </main>
      <footer className="border-t border-slate-200 px-4 py-4 text-center text-xs text-slate-500">
        Your data is processed in this browser and is not uploaded anywhere.
      </footer>
    </div>
  )
}
