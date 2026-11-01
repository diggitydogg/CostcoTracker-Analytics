/**
 * Uploads a locally validated Export V1 dataset through the existing sync
 * protocol (start run → numbered batches → complete). Batches are idempotent on
 * the server, so a failed upload can be resumed with the same run ID.
 */
import type { AnalyticsExportV1 } from '../domain/export/v1'
import { countBatchRows, toSyncBatches, type SyncBatch } from '../domain/sync/protocol'
import { CloudApiError, type CloudApi, type SyncRun } from './api'

export type UploadProgress = {
  phase: 'starting' | 'uploading' | 'finishing' | 'done'
  batchesSent: number
  batchCount: number
  rowsSent: number
  rowCount: number
}

export type UploadPlan = { runId: string; batches: SyncBatch[]; rowCount: number }

export class UploadFailedError extends Error {
  constructor(
    readonly cause: CloudApiError,
    /** Pass back to `uploadDataset` to resume from the failed batch. */
    readonly resume: { runId: string; nextSeq: number },
  ) {
    super(cause.message)
    this.name = 'UploadFailedError'
  }
}

/** Splits the dataset into protocol batches. Throws if a single receipt is too big to send. */
export function planUpload(data: AnalyticsExportV1, runId: string = crypto.randomUUID()): UploadPlan {
  const batches = toSyncBatches(data)
  return { runId, batches, rowCount: batches.reduce((n, b) => n + countBatchRows(b), 0) }
}

const RETRYABLE = (e: CloudApiError) => e.isNetwork || e.status === 503 || e.status === 429

export async function uploadDataset(
  api: CloudApi,
  data: AnalyticsExportV1,
  plan: UploadPlan,
  options: {
    onProgress?: (p: UploadProgress) => void
    startAt?: number
    retryDelaysMs?: number[]
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<SyncRun> {
  const { batches, runId, rowCount } = plan
  const startAt = options.startAt ?? 0
  const delays = options.retryDelaysMs ?? [1000, 3000]
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const rowsBefore = batches.slice(0, startAt).reduce((n, b) => n + countBatchRows(b), 0)
  const progress = (phase: UploadProgress['phase'], batchesSent: number, rowsSent: number) =>
    options.onProgress?.({ phase, batchesSent, batchCount: batches.length, rowsSent, rowCount })

  const withRetry = async <T,>(fn: () => Promise<T>, nextSeq: number): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (e) {
        const error = e instanceof CloudApiError ? e : new CloudApiError(0, 'network', 'The upload was interrupted.')
        if (RETRYABLE(error) && attempt < delays.length) {
          await sleep(delays[attempt]!)
          continue
        }
        throw new UploadFailedError(error, { runId, nextSeq })
      }
    }
  }

  progress('starting', startAt, rowsBefore)
  await withRetry(
    () =>
      api.startRun({
        runId,
        mode: 'incremental',
        formatVersion: 1,
        exportedAt: data.exportedAt,
        currency: data.currency,
      }),
    startAt,
  )

  let rowsSent = rowsBefore
  for (let seq = startAt; seq < batches.length; seq++) {
    const batch = batches[seq]!
    await withRetry(() => api.putBatch(runId, seq, batch), seq)
    rowsSent += countBatchRows(batch)
    progress('uploading', seq + 1, rowsSent)
  }

  progress('finishing', batches.length, rowsSent)
  const { run } = await withRetry(() => api.completeRun(runId, batches.length), batches.length)
  progress('done', batches.length, rowsSent)
  return run
}
