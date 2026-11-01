import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import { createDatasetStore } from '../../persistence/datasetStore'
import { LocalFileApp } from '../../LocalFileApp'
import { createOverridesStore } from '../../persistence/overridesStore'
import { createCloudHarness, enrollTestDevice, fixtureData } from '../../test/cloudHarness'

const options = () => ({ pollMs: 0, retryDelaysMs: [], saveFile: vi.fn(), overridesStore: createOverridesStore(new IDBFactory()), today: '2026-01-15' })

/** Every number the overview shows, in document order. */
const overviewNumbers = (root: HTMLElement) => (within(root).getByLabelText('Summary').textContent ?? '').match(/[$\d][\d,.$%+−-]*/g)

describe('cloud dashboard', () => {
  it('is the landing view, loads the dataset with one request per page, and matches the local file view exactly', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    await h.device.sync(device.deviceToken, fixtureData())
    await h.signIn()
    const before = h.requests.length
    const cloud = render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    const cloudDash = await screen.findByTestId('dashboard')
    const cloudNumbers = overviewNumbers(cloudDash)
    const exportCalls = h.requests.slice(before).filter((r) => r.path.startsWith('/api/export/'))
    expect(exportCalls.map((r) => r.path.split('?')[0])).toEqual([
      '/api/export/meta',
      '/api/export/receipts',
      '/api/export/items',
      '/api/export/returns',
      '/api/export/priceAdjustments',
    ])
    // Only same-origin API calls; nothing else is fetched.
    for (const r of h.requests) expect(r.path).toMatch(/^\/api\//)
    cloud.unmount()

    // The same data opened as a local file renders the same figures.
    const user = userEvent.setup()
    render(<LocalFileApp store={createDatasetStore(new IDBFactory())} />)
    await user.upload(await screen.findByLabelText(/choose export file/i), new File([JSON.stringify(fixtureData())], 'export.json', { type: 'application/json' }))
    const localDash = await screen.findByTestId('dashboard')
    expect(overviewNumbers(localDash)).toEqual(cloudNumbers)
    expect(cloudNumbers!.length).toBeGreaterThan(5)
  })

  it('shows an error if the cloud data cannot be loaded', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    h.failStatus((_, path) => path.startsWith('/api/export/items'), 503)
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503')
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument()
  })

  it('refreshes from the cloud on request', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    const dash = await screen.findByTestId('dashboard')
    const before = h.requests.filter((r) => r.path === '/api/export/meta').length
    await user.click(within(dash).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(h.requests.filter((r) => r.path === '/api/export/meta').length).toBe(before + 1))
    expect(screen.getByTestId('dashboard')).toBeInTheDocument()
  })
})
