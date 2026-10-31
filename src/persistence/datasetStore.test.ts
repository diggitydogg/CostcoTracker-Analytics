// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LoadedDataset } from '../domain/dataset'
import { importExportValue } from '../domain/import/importExport'
import { syntheticExport } from '../test/fixtures'
import { DB_NAME, createDatasetStore } from './datasetStore'

function dataset(): LoadedDataset {
  const result = importExportValue(syntheticExport())
  if (!result.ok) throw new Error('fixture invalid')
  return {
    data: result.data,
    warnings: [{ kind: 'unknown-fields', location: 'items', fields: ['futureField'], recordCount: 2 }],
    meta: { importedAt: '2026-10-31T18:05:00.000Z', sourceLabel: 'synthetic.json', isSyntheticDemo: false },
  }
}

/** Writes a raw value under the store's key, bypassing validation. */
async function putRaw(factory: IDBFactory, value: unknown) {
  // Let the store create the schema first.
  await createDatasetStore(factory).load()
  await new Promise<void>((resolve, reject) => {
    const req = factory.open(DB_NAME)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('dataset', 'readwrite')
      tx.objectStore('dataset').put(value, 'current')
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

async function databaseNames(factory: IDBFactory) {
  return (await factory.databases()).map((d) => d.name)
}

describe('datasetStore', () => {
  let factory: IDBFactory
  beforeEach(() => {
    factory = new IDBFactory()
  })

  it('reports nothing saved on a fresh device', async () => {
    expect(await createDatasetStore(factory).load()).toEqual({ status: 'none' })
  })

  it('round-trips a saved dataset through validation', async () => {
    const store = createDatasetStore(factory)
    const original = dataset()
    await store.save(original)

    const loaded = await createDatasetStore(factory).load()
    expect(loaded.status).toBe('loaded')
    if (loaded.status !== 'loaded') return
    expect(loaded.dataset).toEqual(original)
    expect(typeof loaded.savedAt).toBe('string')
  })

  it('replaces the previous dataset (only one is kept)', async () => {
    const store = createDatasetStore(factory)
    await store.save(dataset())
    const second = dataset()
    second.meta.sourceLabel = 'second.json'
    second.data.items = []
    await store.save(second)

    const loaded = await store.load()
    expect(loaded.status === 'loaded' && loaded.dataset.meta.sourceLabel).toBe('second.json')
    expect(loaded.status === 'loaded' && loaded.dataset.data.items).toEqual([])
  })

  it('forgetLocalData deletes the whole database', async () => {
    const store = createDatasetStore(factory)
    await store.save(dataset())
    expect(await databaseNames(factory)).toContain(DB_NAME)

    await store.forgetLocalData()

    expect(await databaseNames(factory)).not.toContain(DB_NAME)
    expect(await store.load()).toEqual({ status: 'none' })
  })

  it('forgetLocalData succeeds when nothing was saved', async () => {
    await expect(createDatasetStore(factory).forgetLocalData()).resolves.toBeUndefined()
  })

  it('reports a damaged record instead of using it', async () => {
    await putRaw(factory, { storageVersion: 1, nonsense: true })
    const result = await createDatasetStore(factory).load()
    expect(result.status).toBe('corrupt')
  })

  it('reports a record whose export no longer validates', async () => {
    const saved = dataset()
    await putRaw(factory, {
      storageVersion: 1,
      savedAt: '2026-10-31T18:05:00.000Z',
      meta: saved.meta,
      warnings: [],
      export: { ...saved.data, formatVersion: 99 },
    })
    const result = await createDatasetStore(factory).load()
    expect(result.status).toBe('corrupt')
    if (result.status === 'corrupt') expect(result.message).toMatch(/version 99/)
  })

  it('reports a record from a future storage layout as corrupt', async () => {
    await putRaw(factory, { storageVersion: 2 })
    expect((await createDatasetStore(factory).load()).status).toBe('corrupt')
  })

  it('degrades gracefully when IndexedDB is unavailable', async () => {
    const store = createDatasetStore(null)
    expect(store.isAvailable()).toBe(false)
    expect((await store.load()).status).toBe('unavailable')
    await expect(store.save(dataset())).rejects.toThrow()
    await expect(store.forgetLocalData()).resolves.toBeUndefined()
  })
})
