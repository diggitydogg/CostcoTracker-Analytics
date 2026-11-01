import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import { createDatasetStore } from '../../persistence/datasetStore'
import { LocalFileApp } from '../../LocalFileApp'
import { createOverridesStore } from '../../persistence/overridesStore'
import { ACCESS_KEY, createCloudHarness, enrollTestDevice, fixtureData } from '../../test/cloudHarness'
import { syntheticExportText } from '../../test/fixtures'

const exportCalls = (h: { requests: { path: string }[] }, from = 0) =>
  h.requests.slice(from).filter((r) => r.path.startsWith('/api/export/')).map((r) => r.path.split('?')[0])
const FULL_LOAD = ['/api/export/meta', '/api/export/receipts', '/api/export/items', '/api/export/returns', '/api/export/priceAdjustments']
const openTab = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(within(await screen.findByRole('navigation', { name: 'Cloud sections' })).getByRole('button', { name }))

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

  it('reloads fresh cloud data only when asked, with a button that cannot be confused with a Costco refresh', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    const dash = await screen.findByTestId('dashboard')
    expect(within(dash).queryByRole('button', { name: /^Refresh/ })).not.toBeInTheDocument()
    const before = h.requests.length
    await user.click(within(dash).getByRole('button', { name: 'Reload dashboard' }))
    await waitFor(() => expect(exportCalls(h, before)).toEqual(FULL_LOAD))
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument()
    // Only D1 reads: no sync request (the iPhone/Costco refresh workflow) is created.
    expect(h.requests.slice(before).every((r) => r.method === 'GET')).toBe(true)
  })

  it('keeps the dataset in memory across tab switches instead of downloading it again', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    await h.device.sync(device.deviceToken, fixtureData())
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    const first = overviewNumbers(await screen.findByTestId('dashboard'))
    expect(exportCalls(h)).toEqual(FULL_LOAD)

    await openTab(user, 'Sync')
    await screen.findByText('No refresh requests yet.')
    await openTab(user, 'iPhones')
    await openTab(user, 'Dashboard')
    const again = await screen.findByTestId('dashboard')
    expect(overviewNumbers(again)).toEqual(first)
    // Still exactly one full load: returning to the dashboard made no export requests.
    expect(exportCalls(h)).toEqual(FULL_LOAD)
  })

  it('marks the dashboard stale after a web import and reloads only on request', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    await screen.findByText(/There is no purchase data yet/)
    expect(exportCalls(h)).toEqual(FULL_LOAD)

    await openTab(user, 'Import')
    await user.upload(await screen.findByLabelText('Choose export file'), new File([syntheticExportText()], 'export.json', { type: 'application/json' }))
    await user.click(await screen.findByRole('button', { name: 'Upload to cloud' }))
    expect(await screen.findByText('Import complete')).toBeInTheDocument()

    const before = h.requests.length
    await openTab(user, 'Dashboard')
    const banner = await screen.findByText('Your cloud has new data since this dashboard was loaded.')
    expect(exportCalls(h, before)).toEqual([]) // no automatic re-download
    await user.click(within(banner.parentElement!).getByRole('button', { name: 'Reload dashboard' }))
    await waitFor(() => expect(exportCalls(h, before)).toEqual(FULL_LOAD))
    expect(await screen.findByLabelText('Summary')).toBeInTheDocument()
    expect(screen.queryByText('Your cloud has new data since this dashboard was loaded.')).not.toBeInTheDocument()
  })

  it('marks the dashboard stale when the overview sees a newer iPhone sync', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    await screen.findByText(/There is no purchase data yet/)
    await h.device.sync(device.deviceToken, fixtureData()) // the iPhone syncs after the dashboard loaded
    await openTab(user, 'Overview')
    await screen.findByText('Connected')
    const before = h.requests.length
    await openTab(user, 'Dashboard')
    expect(await screen.findByText('Your cloud has new data since this dashboard was loaded.')).toBeInTheDocument()
    expect(exportCalls(h, before)).toEqual([])
  })

  it('drops the in-memory dataset on sign-out', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    await screen.findByTestId('dashboard')
    await openTab(user, 'Overview')
    await user.click(await screen.findByRole('button', { name: 'Sign out of this browser' }))
    await screen.findByText('You are signed out.')
    const before = h.requests.length
    await user.type(screen.getByLabelText('Access key'), ACCESS_KEY)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await openTab(user, 'Dashboard')
    await screen.findByTestId('dashboard')
    // Signing back in starts from nothing: the previous session's copy was not kept.
    // (The Overview tab shown after sign-in makes its own meta request.)
    expect(exportCalls(h, before).filter((p) => p !== '/api/export/meta')).toEqual(FULL_LOAD.slice(1))
  })
})
