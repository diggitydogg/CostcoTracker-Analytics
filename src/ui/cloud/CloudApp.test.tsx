import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import { createCloudApi } from '../../cloud/api'
import { importExportText } from '../../domain/import/importExport'
import { createDatasetStore } from '../../persistence/datasetStore'
import { ACCESS_KEY, createCloudHarness, enrollTestDevice, fixtureData, type CloudHarness } from '../../test/cloudHarness'
import { syntheticExportText } from '../../test/fixtures'

function renderApp(h: CloudHarness, saveFile = vi.fn()) {
  const user = userEvent.setup()
  const view = render(
    <App
      api={h.api}
      store={createDatasetStore(new IDBFactory())}
      cloudTestOptions={{ pollMs: 0, retryDelaysMs: [], saveFile }}
    />,
  )
  return { user, saveFile, ...view }
}

async function signInThroughUi(user: ReturnType<typeof userEvent.setup>, key = ACCESS_KEY) {
  await user.type(await screen.findByLabelText('Access key'), key)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

const openTab = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(within(await screen.findByRole('navigation', { name: 'Cloud sections' })).getByRole('button', { name }))

const jsonFile = (text: string, name = 'export.json') => new File([text], name, { type: 'application/json' })

describe('sign-in and session', () => {
  it('shows the sign-in screen when not signed in and calls no owner endpoints', async () => {
    const h = await createCloudHarness()
    renderApp(h)
    expect(await screen.findByRole('heading', { name: 'Sign in to your cloud' })).toBeInTheDocument()
    const calledPaths = h.requests.map((r) => r.path)
    expect(calledPaths).toEqual(expect.arrayContaining(['/api/auth/session']))
    expect(calledPaths.some((p) => p.startsWith('/api/devices') || p.startsWith('/api/export'))).toBe(false)
  })

  it('rejects a wrong key with a clear message, clears the field, and stores nothing', async () => {
    const h = await createCloudHarness()
    const { user } = renderApp(h)
    await signInThroughUi(user, 'not-the-right-key')
    expect(await screen.findByRole('alert')).toHaveTextContent('That access key is not correct.')
    expect(screen.getByLabelText('Access key')).toHaveValue('')
    expect(screen.getByLabelText('Access key')).toHaveAttribute('type', 'password')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(document.body.innerHTML).not.toContain('not-the-right-key')
  })

  it('asks for a key instead of submitting an empty form', async () => {
    const h = await createCloudHarness()
    const { user } = renderApp(h)
    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your access key.')
    expect(h.requests.some((r) => r.path === '/api/auth/login')).toBe(false)
  })

  it('explains when sign-in has not been configured on the server', async () => {
    const h = await createCloudHarness({ configured: false })
    const { user } = renderApp(h)
    await signInThroughUi(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is not set up on this cloud yet.')
  })

  it('signs in, never persists the key, and shows Cloud status', async () => {
    const h = await createCloudHarness()
    const { user } = renderApp(h)
    await signInThroughUi(user)
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument() // the dashboard is the landing view
    await openTab(user, 'Cloud status')
    expect(await screen.findByRole('heading', { name: 'Cloud status', level: 3 })).toBeInTheDocument()
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('Export version 1')).toBeInTheDocument()
    expect(h.hasSessionCookie()).toBe(true)
    expect(localStorage.length + sessionStorage.length).toBe(0)
    expect(document.body.innerHTML).not.toContain(ACCESS_KEY)
  })

  it('detects an existing session on load and skips the sign-in screen', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'Cloud status')
    expect(await screen.findByRole('heading', { name: 'Cloud status', level: 3 })).toBeInTheDocument()
    expect(screen.queryByLabelText('Access key')).not.toBeInTheDocument()
  })

  it('signs out of this browser', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'Cloud status')
    await user.click(await screen.findByRole('button', { name: 'Sign out of this browser' }))
    expect(await screen.findByText('You are signed out.')).toBeInTheDocument()
    expect(h.hasSessionCookie()).toBe(false)
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  })

  it('requires confirmation to sign out everywhere', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'Cloud status')
    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }))
    expect(screen.getByText(/This signs out every browser/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign out all browsers' }))
    expect(await screen.findByText('You are signed out on every browser.')).toBeInTheDocument()
  })

  it('returns to sign-in with an explanation when the session ends', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'Cloud status')
    await screen.findByText('Connected')
    h.expireSessions()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Your session ended. Sign in again to continue.')).toBeInTheDocument()
    expect(screen.getByLabelText('Access key')).toBeInTheDocument()
  })
})

describe('cloud unavailable', () => {
  it('explains a network failure, retries, and offers the local file viewer', async () => {
    const h = await createCloudHarness()
    h.failNetwork((_, path) => path === '/api/auth/session')
    const { user } = renderApp(h)
    expect(await screen.findByRole('heading', { name: 'Cloud not available' })).toBeInTheDocument()
    expect(screen.getByText(/could not be reached/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Sign in to your cloud' })).toBeInTheDocument()
  })

  it('treats a site without the API as not connected and still allows opening a file', async () => {
    const h = await createCloudHarness()
    h.failStatus((_, path) => path === '/api/auth/session', 404)
    const { user } = renderApp(h)
    expect(await screen.findByText(/not connected to a CostcoTracker cloud/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open an export file on this device' }))
    expect(await screen.findByRole('heading', { name: 'Import your CostcoTracker export' })).toBeInTheDocument()
  })

  it('shows an error on Cloud status when the cloud fails, without leaving the page', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    h.failStatus((_, path) => path === '/api/export/meta', 500, 10)
    const { user } = renderApp(h)
    // The dashboard (landing view) reports the failure in place…
    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected response (HTTP 500)')
    // …and so does Cloud status.
    await openTab(user, 'Cloud status')
    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected response (HTTP 500)')
    expect(screen.getByRole('heading', { name: 'Cloud status', level: 3 })).toBeInTheDocument()
  })
})

describe('iPhone management', () => {
  it('creates a one-time code that the iPhone can use, then lists the iPhone', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'iPhones')
    expect(await screen.findByText('No iPhones are connected yet.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create connection code' }))
    const box = await screen.findByTestId('enrollment-code')
    const code = within(box).getByText(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/).textContent!
    expect(box).toHaveTextContent(/Expires at .* Works once\./)
    expect(box).toHaveTextContent('Cloud sync in the iPhone app arrives in a CostcoTracker update')

    await h.device.enroll(code, 'Kitchen iPhone')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    const list = await screen.findByRole('list', { name: 'Connected iPhones' })
    expect(within(list).getByText('Kitchen iPhone')).toBeInTheDocument()
  })

  it('shows when a code has expired', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'iPhones')
    await user.click(await screen.findByRole('button', { name: 'Create connection code' }))
    await screen.findByTestId('enrollment-code')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000)
      await user.click(screen.getByRole('button', { name: 'Refresh' }))
      expect(await screen.findByText(/This code has expired/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disconnects an iPhone only after explicit confirmation', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h, 'Old iPhone')
    const { user } = renderApp(h)
    await openTab(user, 'iPhones')
    const list = await screen.findByRole('list', { name: 'Connected iPhones' })
    await user.click(within(list).getByRole('button', { name: 'Disconnect' }))
    expect(screen.getByText(/It stops syncing immediately/)).toBeInTheDocument()
    expect((await h.device.call(device.deviceToken, 'GET', '/api/device/config')).status).toBe(200)

    await user.click(screen.getByRole('button', { name: 'Disconnect Old iPhone' }))
    expect(await screen.findByText('“Old iPhone” was disconnected. It can no longer sync.')).toBeInTheDocument()
    expect(await screen.findByText('No iPhones are connected yet.')).toBeInTheDocument()
    expect(screen.getByText('Disconnected iPhones (1)')).toBeInTheDocument()
    expect((await h.device.call(device.deviceToken, 'GET', '/api/device/config')).status).toBe(401)
  })

  it('cancelling a disconnect leaves the iPhone connected', async () => {
    const h = await createCloudHarness()
    await enrollTestDevice(h, 'Keep me')
    const { user } = renderApp(h)
    await openTab(user, 'iPhones')
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(h.db.raw.prepare('SELECT revoked_at FROM devices').get()).toEqual({ revoked_at: null })
  })
})

describe('sync requests and history', () => {
  it('warns when no iPhone is connected', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'Sync')
    expect(await screen.findByText('No iPhone is connected yet')).toBeInTheDocument()
    expect(await screen.findByText(/No syncs yet/)).toBeInTheDocument()
    expect(screen.getByText('No refresh requests yet.')).toBeInTheDocument()
  })

  it('creates a request, explains it waits for the iPhone, and follows it to completion', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    const { user } = renderApp(h)
    await openTab(user, 'Sync')
    expect(await screen.findByText(/This website cannot wake your phone/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Refresh from Costco' }))
    expect(await screen.findByText('Request sent. Open CostcoTracker on your iPhone to start the sync.')).toBeInTheDocument()
    expect(await screen.findByText('Waiting for CostcoTracker on your iPhone')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Refresh from Costco' }))
    expect(await screen.findByText(/A request is already waiting for your iPhone/)).toBeInTheDocument()
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sync_requests').get()).toEqual({ n: 1 })

    const pending = await h.device.call(device.deviceToken, 'GET', '/api/device/sync-requests')
    const requestId = pending.body.requests[0].id
    await h.device.call(device.deviceToken, 'POST', `/api/device/sync-requests/${requestId}/ack`)
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    expect(await screen.findByText('Your iPhone is syncing')).toBeInTheDocument()

    await h.device.sync(device.deviceToken, fixtureData(), 'incremental', requestId)
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    const history = await screen.findByRole('list', { name: 'Sync history' })
    expect(within(history).getByText('Completed')).toBeInTheDocument()
    expect(within(history).getByText(/Test iPhone · Quick sync/)).toBeInTheDocument()
    expect(within(history).getByText('4 new receipts · 3 new returns · 2 new price adjustments')).toBeInTheDocument()
    expect(screen.queryByText(/Request sent/)).not.toBeInTheDocument()
    const requests = screen.getByRole('list', { name: 'Refresh requests' })
    expect(within(requests).getByText('Done')).toBeInTheDocument()
    expect(screen.queryByText('Your iPhone is syncing')).not.toBeInTheDocument()
  })

  it('lets the owner review and confirm records that disappeared from the iPhone', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    await h.device.sync(device.deviceToken, fixtureData(), 'full')
    const wiped = fixtureData((d) => {
      d.receipts = d.receipts.slice(0, 1)
      d.items = d.items.filter((i) => i.purchaseId === 'r_synthetic0001')
      d.returns = []
      d.priceAdjustments = []
    })
    await h.device.sync(device.deviceToken, wiped, 'full')

    const { user } = renderApp(h)
    await openTab(user, 'Sync')
    expect(await screen.findByText('8 records disappeared from your iPhone')).toBeInTheDocument()
    expect(screen.getByText(/Nothing was removed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review missing records' }))
    await user.click(screen.getByRole('button', { name: 'Mark 8 records as gone' }))
    await waitFor(() => expect(screen.queryByText('Needs your review')).not.toBeInTheDocument())
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM receipts WHERE missing_since_run_id IS NOT NULL').get()).toEqual({ n: 3 })
  })

  it('shows an error if the request cannot be sent', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'Sync')
    await screen.findByText('No refresh requests yet.')
    h.failNetwork((m, path) => m === 'POST' && path === '/api/sync-requests')
    await user.click(screen.getByRole('button', { name: 'Refresh from Costco' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach your cloud.')
  })
})

describe('cloud import', () => {
  it('validates locally, uploads through the sync protocol, and reports the result', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'Import')
    await user.upload(await screen.findByLabelText('Choose export file'), jsonFile(syntheticExportText()))
    expect(await screen.findByTestId('import-file-summary')).toHaveTextContent(
      'Valid export (version 1): 4 receipts, 7 items, 3 returns, 2 price adjustments.',
    )
    expect(h.requests.some((r) => r.method !== 'GET' && r.path.startsWith('/api/sync/'))).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Upload to cloud' }))
    expect(await screen.findByText('Import complete')).toBeInTheDocument()
    expect(screen.getByText(/was uploaded: 4 new receipts · 3 new returns · 2 new price adjustments\./)).toBeInTheDocument()
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 7 })
    expect(h.db.raw.prepare("SELECT source, status FROM sync_runs").get()).toEqual({ source: 'web-import', status: 'completed' })
  })

  it('rejects an invalid file locally, sends nothing, and never shows the offending values', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'Import')
    const bad = syntheticExportText((d) => {
      d.receipts[0]!.warehouse = 7
      d.items[0]!.description = 42
      d.receipts[1]!.purchaseDate = 'SECRET-DATE-VALUE'
    })
    await user.upload(await screen.findByLabelText('Choose export file'), jsonFile(bad))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('receipts[1].purchaseDate')
    expect(document.body.innerHTML).not.toContain('SECRET-DATE-VALUE')
    expect(screen.queryByRole('button', { name: 'Upload to cloud' })).not.toBeInTheDocument()
    expect(h.requests.some((r) => r.method !== 'GET' && r.path.startsWith('/api/sync/'))).toBe(false)
  })

  it('resumes an upload interrupted by a network error without duplicating data', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user } = renderApp(h)
    await openTab(user, 'Import')
    await user.upload(await screen.findByLabelText('Choose export file'), jsonFile(syntheticExportText()))
    h.failNetwork((m, path) => m === 'PUT' && path.includes('/batches/0'))
    await user.click(await screen.findByRole('button', { name: 'Upload to cloud' }))
    expect(await screen.findByText('The upload did not finish')).toBeInTheDocument()
    expect(screen.getByText(/Resuming continues where it stopped/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Resume upload' }))
    expect(await screen.findByText('Import complete')).toBeInTheDocument()
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sync_runs').get()).toEqual({ n: 1 })
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toEqual({ n: 4 })
  })

  it('explains a server rejection and does not offer to resume it', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    await h.device.sync(device.deviceToken, fixtureData())
    const { user } = renderApp(h)
    await openTab(user, 'Import')
    const cad = syntheticExportText((d) => (d.currency = 'CAD'))
    await user.upload(await screen.findByLabelText('Choose export file'), jsonFile(cad))
    await user.click(await screen.findByRole('button', { name: 'Upload to cloud' }))
    expect(await screen.findByText('This instance stores USD data; got CAD.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume upload' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel import' }))
    // Cancelling awaits the abort request before clearing the notice.
    await waitFor(() => expect(screen.queryByText('The upload did not finish')).not.toBeInTheDocument())
  })
})

describe('cloud backup', () => {
  it('downloads all cloud data as a file that passes the importer', async () => {
    const h = await createCloudHarness()
    const device = await enrollTestDevice(h)
    await h.device.sync(device.deviceToken, fixtureData())
    const { user, saveFile } = renderApp(h)
    await openTab(user, 'Backup')
    await user.click(await screen.findByRole('button', { name: 'Download backup' }))
    expect(await screen.findByText('Backup saved')).toBeInTheDocument()
    expect(screen.getByText(/contains 4 receipts, 7 items, 3 returns and 2 price adjustments/)).toBeInTheDocument()

    expect(saveFile).toHaveBeenCalledTimes(1)
    const [fileName, text] = saveFile.mock.calls[0]!
    expect(fileName).toMatch(/^costcotracker-analytics-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const reimported = importExportText(text)
    expect(reimported.ok).toBe(true)
    if (reimported.ok) {
      const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort()
      expect(ids(reimported.data.items)).toEqual(ids(fixtureData().items))
    }
  })

  it('creates a valid backup of an empty cloud', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user, saveFile } = renderApp(h)
    await openTab(user, 'Backup')
    await user.click(await screen.findByRole('button', { name: 'Download backup' }))
    expect(await screen.findByText('Backup saved')).toBeInTheDocument()
    expect(importExportText(saveFile.mock.calls[0]![1]).ok).toBe(true)
  })

  it('reports a failed download and saves nothing', async () => {
    const h = await createCloudHarness()
    await h.signIn()
    const { user, saveFile } = renderApp(h)
    await openTab(user, 'Backup')
    h.failStatus((_, path) => path.startsWith('/api/export/items'), 503)
    await user.click(await screen.findByRole('button', { name: 'Download backup' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503')
    expect(saveFile).not.toHaveBeenCalled()
  })
})

describe('networking', () => {
  it('only ever calls same-origin /api paths', async () => {
    const h = await createCloudHarness()
    const { user } = renderApp(h)
    await signInThroughUi(user)
    for (const tab of ['Sync', 'iPhones', 'Import', 'Backup', 'Cloud status']) await openTab(user, tab)
    await screen.findByText('Connected')
    expect(h.requests.length).toBeGreaterThan(5)
    for (const r of h.requests) expect(r.path).toMatch(/^\/api\//)
  })

  it('normalizes API errors without inventing details', async () => {
    const api = createCloudApi(async () => new Response('<html>', { status: 502 }))
    await expect(api.devices()).rejects.toMatchObject({ code: 'unexpected_response', status: 502 })
    const offline = createCloudApi(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(offline.session()).rejects.toMatchObject({ code: 'network', status: 0 })
  })
})
