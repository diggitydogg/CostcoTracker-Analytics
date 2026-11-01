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

  it('names the top-level management tab "Cloud status", leaving the dashboard\'s own Overview section alone', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    const cloudNav = await screen.findByRole('navigation', { name: 'Cloud sections' })
    expect(within(cloudNav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dashboard', 'Cloud status', 'Sync', 'iPhones', 'Import', 'Backup'])
    await screen.findByTestId('dashboard')
    expect(within(screen.getByRole('navigation', { name: 'Dashboard sections' })).getByRole('button', { name: 'Overview' })).toBeInTheDocument()
    await openTab(user, 'Cloud status')
    expect(await screen.findByRole('heading', { name: 'Cloud status', level: 2 })).toBeInTheDocument()
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

  it('marks the dashboard stale when Cloud status sees a newer iPhone sync', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    await screen.findByText(/There is no purchase data yet/)
    await h.device.sync(device.deviceToken, fixtureData()) // the iPhone syncs after the dashboard loaded
    await openTab(user, 'Cloud status')
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
    await openTab(user, 'Cloud status')
    await user.click(await screen.findByRole('button', { name: 'Sign out of this browser' }))
    await screen.findByText('You are signed out.')
    const before = h.requests.length
    await user.type(screen.getByLabelText('Access key'), ACCESS_KEY)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await openTab(user, 'Dashboard')
    await screen.findByTestId('dashboard')
    // Signing back in starts from nothing: the previous session's copy was not kept.
    // (The Cloud status tab shown after sign-in makes its own meta request.)
    expect(exportCalls(h, before).filter((p) => p !== '/api/export/meta')).toEqual(FULL_LOAD.slice(1))
  })
})

describe('cloud AI category suggestions (mocked Workers AI)', () => {
  function aiMock() {
    const inputs: Record<string, unknown>[] = []
    const ai = {
      run: vi.fn(async (_model: string, input: Record<string, unknown>) => {
        inputs.push(input)
        return { response: { suggestions: [{ itemNumber: '9000006', categoryId: 'electronics', subcategoryId: null, confidence: 0.9, reason: 'Anker Solix power station' }] } }
      }),
    }
    return { ai, inputs }
  }
  const withUncategorized = () => fixtureData((d) => (d.items.find((i) => i.itemNumber === '9000006')!.description = 'ANKERSOLIX'))

  it('suggests through the owner endpoint, sends only item numbers/descriptions, and keeps the dataset cache', async () => {
    const { ai, inputs } = aiMock()
    const h = await createCloudHarness({ ai })
    const device = await enrollTestDevice(h)
    await h.device.sync(device.deviceToken, withUncategorized())
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    const dash = await screen.findByTestId('dashboard')
    await user.click(within(screen.getByRole('navigation', { name: 'Dashboard sections' })).getByRole('button', { name: 'Categories' }))
    expect(ai.run).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Suggest categories with AI' }))
    expect(await screen.findByTestId('suggestion-9000006')).toHaveTextContent('Electronics')
    expect(h.requests.filter((r) => r.path === '/api/categories/suggest').map((r) => r.method)).toEqual(['POST'])
    // The model saw exactly this data — nothing about purchases, stores, dates or IDs.
    const user0 = (inputs[0]!.messages as { role: string; content: string }[])[1]!.content
    expect(JSON.parse(user0.slice(user0.indexOf('\n') + 1))).toEqual([{ itemNumber: '9000006', descriptions: ['ANKERSOLIX'] }])
    const everything = JSON.stringify(inputs)
    for (const f of fixtureData().receipts) expect(everything).not.toContain(f.id)
    expect(everything).not.toMatch(/2026-|SYNTHETIC|warehouse|lineTotal|unitPrice/i)

    // Switching cloud tabs and coming back neither re-downloads the export nor re-asks the AI.
    const before = h.requests.length
    await openTab(user, 'Sync')
    await openTab(user, 'Dashboard')
    await screen.findByTestId('dashboard')
    expect(exportCalls(h, before)).toEqual([])
    expect(h.requests.slice(before).some((r) => r.path === '/api/categories/suggest')).toBe(false)
    expect(within(screen.getByTestId('dashboard')).getByRole('button', { name: 'Reload dashboard' })).toBeInTheDocument()
    void dash
  })

  it('explains when Workers AI is not configured and leaves the dashboard usable', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    await h.device.sync(device.deviceToken, withUncategorized())
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    await screen.findByTestId('dashboard')
    await user.click(within(screen.getByRole('navigation', { name: 'Dashboard sections' })).getByRole('button', { name: 'Categories' }))
    await user.click(screen.getByRole('button', { name: 'Suggest categories with AI' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('AI suggestions are not set up on this cloud')
    expect(screen.getByRole('region', { name: 'Spend by category' })).toBeInTheDocument()
  })
})

describe('cloud product identification (fake web search, mocked Workers AI)', () => {
  it('resolves an item number once into the local catalog, and applies the rules from it on reload without searching again', async () => {
    const queries: string[] = []
    const search = {
      name: 'fake',
      search: vi.fn(async (q: string) => {
        queries.push(q)
        return q.includes('9000006')
          ? [{ title: 'Anker SOLIX C1000 Portable Power Station | Costco', url: 'https://www.costco.com/anker.product.1.html', snippet: 'Item 9000006', imageUrl: null }]
          : []
      }),
    }
    const ai = { run: vi.fn(async () => ({ response: { suggestions: [] } })) }
    const h = await createCloudHarness({ search, ai })
    const device = await enrollTestDevice(h)
    await h.device.sync(device.deviceToken, fixtureData((d) => (d.items.find((i) => i.itemNumber === '9000006')!.description = 'ANKERSOLIX')))
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={options()} />)
    await screen.findByTestId('dashboard')
    const toCategories = () => user.click(within(screen.getByRole('navigation', { name: 'Dashboard sections' })).getByRole('button', { name: 'Categories' }))
    await toCategories()
    await user.click(screen.getByRole('button', { name: 'Suggest categories with AI' }))
    expect(await screen.findByTestId('identification-summary')).toHaveTextContent('1 identified by item number (1 now categorized')
    // Only "Costco", the item number and the receipt description reached the search provider.
    expect(queries).toEqual(['Costco 9000006 ANKERSOLIX'])
    // AI was used once, only to normalize the search result; it was never asked for a category.
    const aiInputs = (ai.run.mock.calls as unknown as [string, { messages: { content: string }[] }][]).map((c) => c[1].messages[0]!.content)
    expect(aiInputs).toHaveLength(1)
    expect(aiInputs[0]).toContain('You normalize product identities')
    expect(h.requests.some((r) => r.path === '/api/categories/suggest')).toBe(false)
    // Our own catalog record only; the search result's URL/snippet were used transiently and discarded.
    expect(h.db.raw.prepare('SELECT item_number, status, canonical_name, resolution_basis FROM product_identities').all()).toEqual([
      { item_number: '9000006', status: 'resolved', canonical_name: 'Anker SOLIX C1000 Portable Power Station', resolution_basis: 'costco.com' },
    ])
    const row = JSON.stringify(h.db.raw.prepare('SELECT * FROM product_identities').all())
    expect(row).not.toContain('https://')
    expect(row).not.toContain('Item 9000006')

    // Reload: identities come from the D1 cache with the dataset; no new search.
    await user.click(within(screen.getByTestId('dashboard')).getByRole('button', { name: 'Reload dashboard' }))
    await waitFor(() => expect(h.requests.filter((r) => r.path === '/api/products/identities')).toHaveLength(2))
    await toCategories()
    expect(screen.getByRole('region', { name: 'Uncategorized items' })).not.toHaveTextContent('ANKERSOLIX')
    expect(queries).toHaveLength(1)
  })
})
