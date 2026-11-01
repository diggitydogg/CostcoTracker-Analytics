import { IDBFactory } from 'fake-indexeddb'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import { buildAnalyticsSnapshot } from '../../analytics'
import { createDatasetStore } from '../../persistence/datasetStore'
import { createCloudHarness, enrollTestDevice, fixtureData } from '../../test/cloudHarness'

describe('cloud insights preview', () => {
  it('loads the cloud dataset through the export endpoints and shows the same analytics as local data', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    await h.device.sync(device.deviceToken, fixtureData())
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={{ pollMs: 0, retryDelaysMs: [], saveFile: vi.fn() }} />)
    const nav = await screen.findByRole('navigation', { name: 'Cloud sections' })
    await screen.findByText('Connected', { exact: true }) // overview finished its own requests
    const before = h.requests.length
    await user.click(within(nav).getByRole('button', { name: 'Insights (preview)' }))

    const preview = await screen.findByTestId('analytics-preview')
    // Same engine, same numbers as the local path on the same data.
    const local = buildAnalyticsSnapshot(fixtureData())
    const gross = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(local.spending.lifetime.grossCents / 100)
    const spending = within(preview).getByRole('region', { name: 'Spending' })
    expect(spending).toHaveTextContent(`Gross purchases${gross}`)
    expect(within(preview).getByRole('region', { name: 'Data notes' })).toHaveTextContent('merchandise only')

    // One request per collection page — no per-record requests.
    const exportCalls = h.requests.slice(before).filter((r) => r.path.startsWith('/api/export/'))
    expect(exportCalls.map((r) => r.path.split('?')[0])).toEqual([
      '/api/export/meta',
      '/api/export/receipts',
      '/api/export/items',
      '/api/export/returns',
      '/api/export/priceAdjustments',
    ])
  })

  it('shows an error if the cloud data cannot be loaded', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    h.failStatus((_, path) => path.startsWith('/api/export/items'), 503)
    const user = userEvent.setup()
    render(<App api={h.api} store={createDatasetStore(new IDBFactory())} cloudTestOptions={{ pollMs: 0, retryDelaysMs: [], saveFile: vi.fn() }} />)
    await user.click(within(await screen.findByRole('navigation', { name: 'Cloud sections' })).getByRole('button', { name: 'Insights (preview)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503')
  })
})
