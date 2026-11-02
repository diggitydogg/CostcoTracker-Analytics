import { useState } from 'react'
import { pageFooter, pageHeader, pageMain, pageRow } from './ui/layout/shell'
import type { CloudApi } from './cloud/api'
import { LocalFileApp } from './LocalFileApp'
import type { DatasetStore } from './persistence/datasetStore'
import { CloudApp, type CloudAppTestOptions } from './ui/cloud/CloudApp'

type Mode = 'cloud' | 'file'

/**
 * Two ways in: the owner's cloud (canonical data in D1) or a single export
 * file kept only in this browser.
 */
export function App({
  api,
  store,
  cloudTestOptions,
}: {
  api?: CloudApi
  store?: DatasetStore
  cloudTestOptions?: CloudAppTestOptions
}) {
  const [mode, setMode] = useState<Mode>('cloud')

  return (
    <div className="flex min-h-dvh flex-col">
      <header className={pageHeader}>
        <div className={`${pageRow} flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3`}>
          <h1 className="text-lg font-semibold tracking-tight">CostcoTracker Analytics</h1>
          <nav aria-label="Data source">
            <ul className="flex gap-1 text-sm">
              {(
                [
                  ['cloud', 'Cloud'],
                  ['file', 'File on this device'],
                ] as const
              ).map(([id, label]) => (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={mode === id ? 'page' : undefined}
                    onClick={() => setMode(id)}
                    className={`rounded-md px-3 py-1.5 font-medium ${mode === id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
                  >
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      {mode === 'cloud' ? (
        <>
          <main className={pageMain}>
            <CloudApp
              {...(api ? { api } : {})}
              onOpenFile={() => setMode('file')}
              {...(cloudTestOptions ? { testOptions: cloudTestOptions } : {})}
            />
          </main>
          <footer className={pageFooter}>
            Your purchase data stays in your own cloud. Optional product identification sends only the Costco item number and abbreviated product description to the configured search provider. No trackers.
          </footer>
        </>
      ) : (
        <LocalFileApp {...(store ? { store } : {})} />
      )}
    </div>
  )
}
