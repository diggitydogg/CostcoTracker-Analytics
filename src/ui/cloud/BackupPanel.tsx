import { useState } from 'react'
import { BackupInvalidError, createCloudBackup, saveTextFile, type BackupProgress, type CloudBackup } from '../../cloud/cloudBackup'
import { useCloud } from '../../cloud/CloudContext'
import { ImportErrorPanel } from '../ImportErrorPanel'
import { plural } from './format'
import { Button, Notice, Section } from './primitives'

type Stage =
  | { kind: 'idle' }
  | { kind: 'working'; progress: BackupProgress | null }
  | { kind: 'saved'; backup: CloudBackup }
  | { kind: 'error'; message: string }
  | { kind: 'invalid'; error: BackupInvalidError }

/**
 * Downloads everything in the cloud as a standard export file. The file is
 * validated with the same importer used for imports before it is saved, so a
 * backup is known to restore cleanly.
 */
export function BackupPanel({ save = saveTextFile }: { save?: (fileName: string, text: string) => void }) {
  const { api, handle } = useCloud()
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })

  async function run() {
    setStage({ kind: 'working', progress: null })
    try {
      const backup = await createCloudBackup(api, { onProgress: (progress) => setStage({ kind: 'working', progress }) })
      save(backup.fileName, backup.json)
      setStage({ kind: 'saved', backup })
    } catch (e) {
      if (e instanceof BackupInvalidError) setStage({ kind: 'invalid', error: e })
      else setStage({ kind: 'error', message: handle(e) })
    }
  }

  const working = stage.kind === 'working'
  const pct =
    stage.kind === 'working' && stage.progress && stage.progress.total > 0
      ? Math.round((stage.progress.fetched / stage.progress.total) * 100)
      : 0

  return (
    <div className="space-y-4">
      <Section
        title="Download a backup"
        description={
          <>
            Saves everything in your cloud as a CostcoTracker export file on this device. Keep it somewhere safe; you
            can import it again here at any time. Records no longer on your iPhone are not included.
          </>
        }
      >
        <div className="space-y-3">
          <Button variant="primary" onClick={() => void run()} disabled={working}>
            {working ? 'Preparing backup…' : 'Download backup'}
          </Button>

          {stage.kind === 'working' && (
            <div className="space-y-2">
              <div
                role="progressbar"
                aria-label="Backup progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
              >
                <div className="h-full bg-sky-600 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <p role="status" className="text-sm text-slate-700">
                {stage.progress
                  ? `Downloaded ${stage.progress.fetched.toLocaleString()} of ${stage.progress.total.toLocaleString()} records`
                  : 'Contacting your cloud…'}
              </p>
            </div>
          )}

          {stage.kind === 'saved' && (
            <Notice tone="success" title="Backup saved">
              {stage.backup.fileName} contains {plural(stage.backup.counts.receipts, 'receipt')},{' '}
              {plural(stage.backup.counts.items, 'item')}, {plural(stage.backup.counts.returns, 'return')} and{' '}
              {plural(stage.backup.counts.priceAdjustments, 'price adjustment')}. It was checked and will import cleanly.
            </Notice>
          )}

          {stage.kind === 'error' && <Notice tone="error">{stage.message}</Notice>}

          {stage.kind === 'invalid' && (
            <div className="space-y-2">
              <Notice tone="error">
                {stage.error.message} This can happen if your iPhone was syncing at the same moment; try again in a
                minute.
              </Notice>
              <ImportErrorPanel error={stage.error.importError} onDismiss={() => setStage({ kind: 'idle' })} />
            </div>
          )}
        </div>
      </Section>

      <Section title="Full database copy" description="For moving to another host or a complete disaster-recovery copy.">
        <p className="text-sm text-slate-700">
          The export file above holds all of your purchase data. A complete copy of the cloud database (including
          connected iPhones and sync history) can be made from a computer with <code>npm run db:backup:remote -- backup.sql</code>.
          Treat that file as private.
        </p>
      </Section>
    </div>
  )
}
