import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { App } from './App'
import { DB_NAME, createDatasetStore } from './persistence/datasetStore'
import { syntheticExportText } from './test/fixtures'

function jsonFile(text: string, name = 'costcotracker-export.json') {
  return new File([text], name, { type: 'application/json' })
}

async function renderApp(factory: IDBFactory | null) {
  const user = userEvent.setup()
  const store = createDatasetStore(factory)
  const view = render(<App store={store} />)
  await screen.findByRole('heading', { name: /import your costcotracker export/i }).catch(() => undefined)
  return { user, store, ...view }
}

async function upload(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.upload(screen.getByLabelText(/choose export file/i), file)
}

async function hasSavedDatabase(factory: IDBFactory) {
  return (await factory.databases()).some((d) => d.name === DB_NAME)
}

describe('App import flow', () => {
  let factory: IDBFactory
  beforeEach(() => {
    factory = new IDBFactory()
  })

  it('shows the import screen when nothing is saved', async () => {
    await renderApp(factory)
    expect(await screen.findByRole('heading', { name: /import your costcotracker export/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /forget imported data/i })).not.toBeInTheDocument()
  })

  it('imports a valid file and shows record counts', async () => {
    const { user } = await renderApp(factory)
    await screen.findByLabelText(/choose export file/i)
    await upload(user, jsonFile(syntheticExportText()))

    const summary = await screen.findByRole('region', { name: /imported records/i })
    expect(within(summary).getByText('Items').nextSibling).toHaveTextContent('7')
    expect(within(summary).getByText('Receipts / orders', { selector: 'dt' }).nextSibling).toHaveTextContent('4')
    expect(screen.getByTestId('storage-status')).toHaveTextContent(/not saved/i)
    // Not remembered → nothing persisted.
    expect(await hasSavedDatabase(factory)).toBe(false)
  })

  it('shows an actionable error for malformed JSON and imports nothing', async () => {
    const { user } = await renderApp(factory)
    await screen.findByLabelText(/choose export file/i)
    await upload(user, jsonFile('{ not json'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This file is not valid JSON.')
    expect(screen.queryByRole('region', { name: /imported records/i })).not.toBeInTheDocument()
  })

  it('lists field-level problems for invalid data', async () => {
    const { user } = await renderApp(factory)
    await screen.findByLabelText(/choose export file/i)
    await upload(user, jsonFile(syntheticExportText((d) => (d.items[0]!.unitPriceCents = 21.99))))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This export has 1 problem with its data.')
    expect(alert).toHaveTextContent('items[0].unitPriceCents')
  })

  it('explains an unsupported format version', async () => {
    const { user } = await renderApp(factory)
    await screen.findByLabelText(/choose export file/i)
    await upload(user, jsonFile(syntheticExportText((d) => (d.formatVersion = 2))))
    expect(await screen.findByRole('alert')).toHaveTextContent('Export format version 2 is not supported.')
  })

  it('remembers the dataset when opted in and restores it on next visit', async () => {
    const { user, unmount } = await renderApp(factory)
    await screen.findByLabelText(/choose export file/i)
    await user.click(screen.getByRole('checkbox', { name: /remember this dataset/i }))
    await upload(user, jsonFile(syntheticExportText()))
    await screen.findByRole('region', { name: /imported records/i })
    expect(screen.getByTestId('storage-status')).toHaveTextContent('Saved on this device')
    unmount()

    // A new visit with the same browser storage.
    render(<App store={createDatasetStore(factory)} />)
    expect(await screen.findByRole('region', { name: /imported records/i })).toBeInTheDocument()
    expect(screen.getByTestId('storage-status')).toHaveTextContent('Saved on this device')
  })

  it('"Forget imported data" clears memory and deletes on-device storage', async () => {
    const { user } = await renderApp(factory)
    await screen.findByLabelText(/choose export file/i)
    await user.click(screen.getByRole('checkbox', { name: /remember this dataset/i }))
    await upload(user, jsonFile(syntheticExportText()))
    await screen.findByRole('region', { name: /imported records/i })
    expect(await hasSavedDatabase(factory)).toBe(true)

    await user.click(screen.getByRole('button', { name: /forget imported data/i }))
    await user.click(screen.getByRole('button', { name: /yes, forget it/i }))

    expect(await screen.findByRole('heading', { name: /import your costcotracker export/i })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /imported records/i })).not.toBeInTheDocument()
    await waitFor(async () => expect(await hasSavedDatabase(factory)).toBe(false))
  })

  it('importing without "remember" removes a previously saved dataset', async () => {
    const first = await renderApp(factory)
    await screen.findByLabelText(/choose export file/i)
    await first.user.click(screen.getByRole('checkbox', { name: /remember this dataset/i }))
    await upload(first.user, jsonFile(syntheticExportText()))
    await screen.findByRole('region', { name: /imported records/i })

    await first.user.click(screen.getByRole('button', { name: /import a different file/i }))
    await upload(first.user, jsonFile(syntheticExportText((d) => (d.items = []))))
    await screen.findByRole('region', { name: /imported records/i })
    expect(screen.getByTestId('storage-status')).toHaveTextContent(/not saved/i)
    expect(await hasSavedDatabase(factory)).toBe(false)
  })

  it('loads the synthetic demo dataset and labels it as synthetic', async () => {
    const { user } = await renderApp(factory)
    await user.click(await screen.findByRole('button', { name: /synthetic demo data/i }))
    expect(await screen.findByText(/you are viewing synthetic demo data/i)).toBeInTheDocument()
  })

  it('reports ignored unknown field names on the details view', async () => {
    const { user } = await renderApp(factory)
    await screen.findByLabelText(/choose export file/i)
    await upload(user, jsonFile(syntheticExportText((d) => (d.items[0]!.futureField = 'value'))))
    await user.click(await screen.findByRole('button', { name: /import details/i }))
    expect(screen.getByTestId('import-warnings')).toHaveTextContent('items: futureField (1 record)')
  })

  it('offers a working forget action when saved data is corrupt', async () => {
    // Save valid data, then corrupt it in place.
    await createDatasetStore(factory).load()
    await new Promise<void>((resolve) => {
      const req = factory.open(DB_NAME)
      req.onsuccess = () => {
        const tx = req.result.transaction('dataset', 'readwrite')
        tx.objectStore('dataset').put({ storageVersion: 1, broken: true }, 'current')
        tx.oncomplete = () => {
          req.result.close()
          resolve()
        }
      }
    })
    const { user } = await renderApp(factory)
    expect(await screen.findByRole('alert')).toHaveTextContent(/saved dataset on this device/i)
    await user.click(screen.getByRole('button', { name: /forget imported data/i }))
    await user.click(screen.getByRole('button', { name: /yes, forget it/i }))
    await waitFor(async () => expect(await hasSavedDatabase(factory)).toBe(false))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('works without IndexedDB, keeping data in memory only', async () => {
    const { user } = await renderApp(null)
    expect(await screen.findByRole('checkbox', { name: /remember this dataset/i })).toBeDisabled()
    await upload(user, jsonFile(syntheticExportText()))
    await screen.findByRole('region', { name: /imported records/i })
    expect(screen.getByTestId('storage-status')).toHaveTextContent(/storage unavailable/i)
  })
})
