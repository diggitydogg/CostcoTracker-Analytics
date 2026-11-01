import { useMemo, useState } from 'react'
import { createCloudApi, type CloudApi } from '../../cloud/api'
import { CloudContext } from '../../cloud/CloudContext'
import { CloudDatasetProvider } from '../../cloud/CloudDatasetProvider'
import { useCloudSession } from '../../cloud/useCloudSession'
import type { OverridesStore } from '../../persistence/overridesStore'
import { LazyCloudDashboard } from '../dashboard/lazy'
import { BackupPanel } from './BackupPanel'
import { DevicesPanel } from './DevicesPanel'
import { ImportPanel } from './ImportPanel'
import { LoginScreen } from './LoginScreen'
import { OverviewPanel } from './OverviewPanel'
import { Button, Notice } from './primitives'
import { SyncPanel } from './SyncPanel'

type Tab = 'dashboard' | 'overview' | 'sync' | 'devices' | 'import' | 'backup'
const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'overview', label: 'Cloud status' },
  { id: 'sync', label: 'Sync' },
  { id: 'devices', label: 'iPhones' },
  { id: 'import', label: 'Import' },
  { id: 'backup', label: 'Backup' },
]

export type CloudAppTestOptions = {
  pollMs?: number
  retryDelaysMs?: number[]
  saveFile?: (name: string, text: string) => void
  overridesStore?: OverridesStore
  today?: string
}

export function CloudApp({
  api: providedApi,
  onOpenFile,
  testOptions = {},
}: {
  api?: CloudApi
  onOpenFile: () => void
  testOptions?: CloudAppTestOptions
}) {
  const api = useMemo(() => providedApi ?? createCloudApi(), [providedApi])
  const session = useCloudSession(api)
  const [tab, setTab] = useState<Tab>('dashboard')
  const context = useMemo(() => ({ api, sessionLost: session.sessionLost }), [api, session.sessionLost])

  const { state } = session
  if (state.kind === 'checking') {
    return (
      <p role="status" className="text-sm text-slate-600">
        Connecting to your cloud…
      </p>
    )
  }
  if (state.kind === 'unreachable') {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Cloud not available</h2>
        <Notice tone="warning">{state.message}</Notice>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={session.recheck}>
            Try again
          </Button>
          <Button onClick={onOpenFile}>Open an export file on this device</Button>
        </div>
      </div>
    )
  }
  if (state.kind === 'signed-out') {
    return <LoginScreen notice={state.notice} onLogin={session.login} onOpenFile={onOpenFile} />
  }

  return (
    <CloudContext.Provider value={context}>
      {/* Keeps the dashboard's dataset in memory while switching tabs. */}
      <CloudDatasetProvider>
        <div className="space-y-5">
          <nav aria-label="Cloud sections">
            <ul className="flex flex-wrap gap-1 rounded-lg bg-slate-200 p-1">
              {TABS.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-current={tab === t.id ? 'page' : undefined}
                    onClick={() => setTab(t.id)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === t.id ? 'bg-white shadow-sm' : 'text-slate-700 hover:bg-slate-100'}`}
                  >
                    {t.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {tab === 'dashboard' && (
            <LazyCloudDashboard
              {...(testOptions.overridesStore ? { overridesStore: testOptions.overridesStore } : {})}
              {...(testOptions.today ? { today: testOptions.today } : {})}
            />
          )}
          {tab !== 'dashboard' && (
            // Management screens keep a comfortable reading width; the dashboard uses the full width.
            <div className="max-w-5xl space-y-5">
              <h2 className="sr-only">{TABS.find((t) => t.id === tab)!.label}</h2>
              {tab === 'overview' && (
                <OverviewPanel formatVersion={state.formatVersion} onLogout={session.logout} onLogoutEverywhere={session.logoutEverywhere} />
              )}
              {tab === 'sync' && (
                <SyncPanel onAddDevice={() => setTab('devices')} {...(testOptions.pollMs !== undefined ? { pollMs: testOptions.pollMs } : {})} />
              )}
              {tab === 'devices' && <DevicesPanel />}
              {tab === 'import' && <ImportPanel {...(testOptions.retryDelaysMs ? { retryDelaysMs: testOptions.retryDelaysMs } : {})} />}
              {tab === 'backup' && <BackupPanel {...(testOptions.saveFile ? { save: testOptions.saveFile } : {})} />}
            </div>
          )}
        </div>
      </CloudDatasetProvider>
    </CloudContext.Provider>
  )
}
