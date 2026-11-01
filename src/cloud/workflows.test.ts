import { describe, expect, it, vi } from 'vitest'
import { createCloudHarness, fixtureData } from '../test/cloudHarness'
import type { CloudApi, ExportMeta } from './api'
import { BackupInvalidError, createCloudBackup } from './cloudBackup'
import { UploadFailedError, planUpload, uploadDataset, type UploadProgress } from './uploadDataset'

const isBatch = (seq: number) => (m: string, path: string) => m === 'PUT' && path.endsWith(`/batches/${seq}`)

describe('uploadDataset', () => {
  it('retries transient failures automatically and reports progress to completion', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const data = fixtureData()
    const plan = planUpload(data)
    h.failStatus(isBatch(0), 503)
    h.failNetwork(isBatch(0))
    const sleep = vi.fn(async () => {})
    const events: UploadProgress[] = []
    const run = await uploadDataset(h.api, data, plan, { retryDelaysMs: [10, 20], sleep, onProgress: (p) => events.push(p) })
    expect(run.status).toBe('completed')
    expect(sleep.mock.calls).toEqual([[10], [20]])
    expect(events[0]!.phase).toBe('starting')
    expect(events.at(-1)).toMatchObject({ phase: 'done', rowsSent: 16, rowCount: 16 })
    const sent = events.map((e) => e.rowsSent)
    expect([...sent].sort((a, b) => a - b)).toEqual(sent)
  })

  it('gives up after the retry budget with enough information to resume', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const data = fixtureData()
    const plan = planUpload(data)
    h.failNetwork(isBatch(0), 3)
    const error = await uploadDataset(h.api, data, plan, { retryDelaysMs: [0, 0], sleep: async () => {} }).catch((e) => e)
    expect(error).toBeInstanceOf(UploadFailedError)
    expect(error.resume).toEqual({ runId: plan.runId, nextSeq: 0 })
    expect(error.cause.code).toBe('network')
    const resumed = await uploadDataset(h.api, data, plan, { startAt: error.resume.nextSeq })
    expect(resumed.receipts_inserted).toBe(4)
  })

  it('does not retry a rejected batch', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const data = fixtureData()
    const plan = planUpload(data)
    plan.batches[0]!.receipts[0]!.items[0]!.lineTotalCents = 1 // now disagrees with its unit price
    const sleep = vi.fn(async () => {})
    const error = await uploadDataset(h.api, data, plan, { sleep }).catch((e) => e)
    expect(error.cause.status).toBe(400)
    // Integrity issues in a batch are reported with flattened export paths.
    expect(error.cause.issues[0].path).toBe('items[0].lineTotalCents')
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('createCloudBackup', () => {
  it('pages through every collection', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    await uploadDataset(h.api, fixtureData(), planUpload(fixtureData()))
    const backup = await createCloudBackup(h.api, { pageSize: 2 })
    expect(backup.counts).toEqual({ receipts: 4, items: 7, returns: 3, priceAdjustments: 2 })
    const itemPages = h.requests.filter((r) => r.path.startsWith('/api/export/items')).length
    expect(itemPages).toBe(4)
  })

  it('refuses to produce a backup that would not re-import', async () => {
    const meta: ExportMeta = {
      format: 'costcotracker-analytics',
      formatVersion: 1,
      exportedAt: '2026-10-31T18:00:00.000Z',
      currency: 'USD',
      changeSeq: 1,
      counts: { receipts: 0, items: 1, returns: 0, priceAdjustments: 0, tombstoned: 0 },
    }
    const item = { id: 'i_1', purchaseId: 'r_missing', itemNumber: '1', description: 'x', quantity: 1, lineTotalCents: 1, unitPriceCents: 1 }
    const api = {
      exportMeta: async () => meta,
      exportPage: async (collection: string) => ({
        collection,
        records: collection === 'items' ? [{ record: item, changeSeq: 1, missing: false }] : [],
        nextCursor: null,
      }),
    } as unknown as CloudApi
    const error = await createCloudBackup(api).catch((e) => e)
    expect(error).toBeInstanceOf(BackupInvalidError)
    expect(error.importError.issues[0].path).toBe('items[0].purchaseId')
  })
})
