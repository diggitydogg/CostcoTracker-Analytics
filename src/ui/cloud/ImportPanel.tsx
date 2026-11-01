import { useId, useRef, useState } from 'react'
import { CloudApiError, type SyncRun } from '../../cloud/api'
import { useCloud } from '../../cloud/CloudContext'
import { UploadFailedError, planUpload, uploadDataset, type UploadPlan, type UploadProgress } from '../../cloud/uploadDataset'
import type { AnalyticsExportV1 } from '../../domain/export/v1'
import { MAX_IMPORT_BYTES, importExportText, tooLargeError, type ImportError } from '../../domain/import/importExport'
import { summarizeImport } from '../../domain/summary'
import { ImportErrorPanel } from '../ImportErrorPanel'
import { plural, runSummary } from './format'
import { Button, Notice, Section } from './primitives'

type Stage =
  | { kind: 'idle' }
  | { kind: 'invalid'; error: ImportError }
  | { kind: 'ready'; fileName: string; data: AnalyticsExportV1; plan: UploadPlan }
  | { kind: 'uploading'; fileName: string; data: AnalyticsExportV1; plan: UploadPlan; progress: UploadProgress | null }
  | {
      kind: 'failed'
      fileName: string
      data: AnalyticsExportV1
      plan: UploadPlan
      message: string
      issues: { path: string; message: string }[]
      resume: { runId: string; nextSeq: number }
      canResume: boolean
    }
  | { kind: 'done'; fileName: string; run: SyncRun }

/**
 * Upload a CostcoTracker export file to the cloud (first-time setup or
 * disaster recovery). The file is validated in this browser with the same
 * importer as the local viewer before anything is sent.
 */
export function ImportPanel({ retryDelaysMs }: { retryDelaysMs?: number[] }) {
  const { api, handle } = useCloud()
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })

  async function chooseFile(file: File | undefined) {
    if (!file) return
    if (inputRef.current) inputRef.current.value = ''
    if (file.size > MAX_IMPORT_BYTES) {
      setStage({ kind: 'invalid', error: tooLargeError() })
      return
    }
    let text: string
    try {
      text = await file.text()
    } catch {
      setStage({
        kind: 'invalid',
        error: {
          kind: 'unreadable',
          message: 'The file could not be read.',
          hint: 'Check that the file still exists and try again.',
          issues: [],
          totalIssueCount: 0,
        },
      })
      return
    }
    const result = importExportText(text)
    if (!result.ok) {
      setStage({ kind: 'invalid', error: result.error })
      return
    }
    try {
      setStage({ kind: 'ready', fileName: file.name, data: result.data, plan: planUpload(result.data) })
    } catch (e) {
      setStage({
        kind: 'invalid',
        error: {
          kind: 'invalid-data',
          message: 'This file has a receipt too large to upload.',
          hint: e instanceof Error ? e.message : 'Split the export and try again.',
          issues: [],
          totalIssueCount: 0,
        },
      })
    }
  }

  async function upload(fileName: string, data: AnalyticsExportV1, plan: UploadPlan, startAt = 0) {
    setStage({ kind: 'uploading', fileName, data, plan, progress: null })
    try {
      const run = await uploadDataset(api, data, plan, {
        startAt,
        ...(retryDelaysMs ? { retryDelaysMs } : {}),
        onProgress: (progress) => setStage({ kind: 'uploading', fileName, data, plan, progress }),
      })
      setStage({ kind: 'done', fileName, run })
    } catch (e) {
      const cause = e instanceof UploadFailedError ? e.cause : e
      const message = handle(cause)
      const apiError = cause instanceof CloudApiError ? cause : null
      setStage({
        kind: 'failed',
        fileName,
        data,
        plan,
        message,
        issues: apiError?.issues ?? [],
        resume: e instanceof UploadFailedError ? e.resume : { runId: plan.runId, nextSeq: 0 },
        // Retrying can help with connection problems, not with rejected data.
        canResume: apiError === null || apiError.isNetwork || apiError.status >= 500 || apiError.status === 429,
      })
    }
  }

  async function cancel(runId: string) {
    try {
      await api.abortRun(runId)
    } catch {
      // The run is abandoned automatically after a day; nothing else to do.
    }
    setStage({ kind: 'idle' })
  }

  const busy = stage.kind === 'uploading'

  return (
    <div className="space-y-4">
      <Section
        title="Import an export file"
        description={
          <>
            Use this to load your history the first time, or to restore from a backup. The file is checked in this
            browser first; nothing is sent unless it is valid. Importing adds and updates records — it never removes
            anything from the cloud.
          </>
        }
      >
        <div className="space-y-4">
          <label
            htmlFor={inputId}
            className={`inline-block rounded-md px-4 py-2 text-sm font-medium text-white has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sky-600 ${busy ? 'cursor-not-allowed bg-sky-700/50' : 'cursor-pointer bg-sky-700 hover:bg-sky-800'}`}
          >
            Choose export file
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              disabled={busy}
              onChange={(e) => void chooseFile(e.target.files?.[0])}
            />
          </label>

          {stage.kind === 'invalid' && (
            <ImportErrorPanel error={stage.error} onDismiss={() => setStage({ kind: 'idle' })} />
          )}

          {(stage.kind === 'ready' || stage.kind === 'uploading' || stage.kind === 'failed') && (
            <FileSummary fileName={stage.fileName} data={stage.data} />
          )}

          {stage.kind === 'ready' && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void upload(stage.fileName, stage.data, stage.plan)}>
                Upload to cloud
              </Button>
              <Button onClick={() => setStage({ kind: 'idle' })}>Choose a different file</Button>
            </div>
          )}

          {stage.kind === 'uploading' && <UploadProgressView progress={stage.progress} />}

          {stage.kind === 'failed' && (
            <div className="space-y-3">
              <Notice tone="error" title="The upload did not finish">
                <p>{stage.message}</p>
                {stage.issues.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 font-mono text-xs">
                    {stage.issues.slice(0, 10).map((issue, i) => (
                      <li key={i} className="break-words">
                        {issue.path}: {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2">
                  {stage.canResume
                    ? 'Parts already uploaded are kept. Resuming continues where it stopped.'
                    : 'Nothing in this part was stored. Check the file, then try again.'}
                </p>
              </Notice>
              <div className="flex flex-wrap gap-2">
                {stage.canResume && (
                  <Button
                    variant="primary"
                    onClick={() => void upload(stage.fileName, stage.data, stage.plan, stage.resume.nextSeq)}
                  >
                    Resume upload
                  </Button>
                )}
                <Button onClick={() => void cancel(stage.resume.runId)}>Cancel import</Button>
              </div>
            </div>
          )}

          {stage.kind === 'done' && (
            <Notice tone="success" title="Import complete">
              {stage.fileName} was uploaded: {runSummary(stage.run)}.
            </Notice>
          )}
        </div>
      </Section>
    </div>
  )
}

function FileSummary({ fileName, data }: { fileName: string; data: AnalyticsExportV1 }) {
  const s = summarizeImport(data)
  return (
    <div className="rounded-md border border-slate-200 p-3 text-sm" data-testid="import-file-summary">
      <p className="font-medium break-all">{fileName}</p>
      <p className="mt-1 text-slate-700">
        Valid export (version {data.formatVersion}): {plural(s.receiptCount, 'receipt')}, {plural(s.itemCount, 'item')},{' '}
        {plural(s.returnCount, 'return')}, {plural(s.priceAdjustmentCount, 'price adjustment')}.
      </p>
    </div>
  )
}

function UploadProgressView({ progress }: { progress: UploadProgress | null }) {
  const pct = progress && progress.rowCount > 0 ? Math.round((progress.rowsSent / progress.rowCount) * 100) : 0
  const label = !progress
    ? 'Starting upload…'
    : progress.phase === 'finishing'
      ? 'Finishing up…'
      : `Uploaded ${progress.batchesSent} of ${progress.batchCount} parts (${progress.rowsSent.toLocaleString()} of ${progress.rowCount.toLocaleString()} records)`
  return (
    <div className="space-y-2">
      <div
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
      >
        <div className="h-full bg-sky-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-slate-700" role="status">
        {label}
      </p>
    </div>
  )
}
