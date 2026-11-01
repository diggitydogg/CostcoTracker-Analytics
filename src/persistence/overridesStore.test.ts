import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createDatasetStore } from './datasetStore'
import { createOverridesStore } from './overridesStore'
import { DB_NAME, SETTINGS_STORE, withAppStore } from './appDb'

describe('category overrides store', () => {
  it('saves and loads validated overrides', async () => {
    const factory = new IDBFactory()
    const store = createOverridesStore(factory)
    expect(await store.load()).toEqual({ status: 'none' })
    await store.save({ '123': { categoryId: 'grocery', subcategoryId: 'produce' } })
    expect(await createOverridesStore(factory).load()).toEqual({ status: 'loaded', overrides: { '123': { categoryId: 'grocery', subcategoryId: 'produce' } } })
  })

  it('reports corrupt data instead of using it', async () => {
    const factory = new IDBFactory()
    await createOverridesStore(factory).save({})
    await withAppStore(factory, SETTINGS_STORE, 'readwrite', (s) => s.put('{"format":"nope"}', 'categoryOverrides'))
    expect(await createOverridesStore(factory).load()).toEqual({ status: 'corrupt' })
  })

  it('is unavailable without IndexedDB', async () => {
    const store = createOverridesStore(null)
    expect(store.isAvailable()).toBe(false)
    expect(await store.load()).toEqual({ status: 'unavailable' })
  })

  it('lives in the app database, so "forget local data" removes it too', async () => {
    const factory = new IDBFactory()
    await createOverridesStore(factory).save({ '1': { categoryId: 'pet' } })
    expect((await factory.databases()).map((d) => d.name)).toContain(DB_NAME)
    await createDatasetStore(factory).forgetLocalData()
    expect(await createOverridesStore(factory).load()).toEqual({ status: 'none' })
  })

  it('upgrades a version-1 database (dataset only) without losing the dataset store', async () => {
    const factory = new IDBFactory()
    await new Promise<void>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('dataset')
      req.onsuccess = () => {
        req.result.close()
        resolve()
      }
      req.onerror = () => reject(req.error)
    })
    await createOverridesStore(factory).save({ '1': { categoryId: 'pet' } })
    expect(await createDatasetStore(factory).load()).toEqual({ status: 'none' })
  })
})
