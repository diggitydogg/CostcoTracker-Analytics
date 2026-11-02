import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateDataset } from '../../analytics/test/builder'
import type { ProductIdentity } from '../../analytics/products/identityProtocol'
import type { PhotoEvidence } from '../../analytics/products/photoMatch'
import { createOverridesStore } from '../../persistence/overridesStore'
import { mockAvailableWidth } from '../../test/resize'
import type { CatalogEditor, PhotoServices } from '../dashboard/context'
import { Dashboard } from '../dashboard/Dashboard'
import type { DeviceReader } from './deviceReader'
import type { OnDeviceRead } from './onDevice'
import { PhotoInputError } from './prepareImage'

const COMPACT = 375
const WIDE = 1180
const DATA_URL = 'data:image/jpeg;base64,QUJD'
const data = generateDataset({ receipts: 40, itemsPerReceipt: 4, returns: 3, adjustments: 2, seed: 7 })
const itemBy = (description: string) => data.items.find((i) => i.description === description)!

const aiEvidence = (over: Partial<PhotoEvidence>): PhotoEvidence => ({
  source: 'ai-vision',
  quality: 'ok',
  brand: null,
  productName: null,
  variant: null,
  size: null,
  productType: null,
  modelNumber: null,
  barcodes: [],
  numbers: [],
  visibleText: [],
  ...over,
})

let space: ReturnType<typeof mockAvailableWidth> | null = null
afterEach(() => {
  space?.restore()
  space = null
})

function setup(opts: { width?: number; read?: OnDeviceRead | Error; prepare?: Error; evidence?: PhotoEvidence | Error; identities?: Record<string, ProductIdentity> } = {}) {
  space = mockAvailableWidth(opts.width ?? COMPACT)
  const device: DeviceReader = {
    prepare: vi.fn(async () => {
      if (opts.prepare) throw opts.prepare
      return { dataUrl: DATA_URL }
    }),
    read: vi.fn(async () => {
      if (opts.read instanceof Error) throw opts.read
      return opts.read ?? { lines: [], barcodes: [] }
    }),
    release: vi.fn(),
  }
  const photo: PhotoServices = {
    evidence: vi.fn(async () => {
      if (opts.evidence instanceof Error) throw opts.evidence
      return opts.evidence ?? aiEvidence({ quality: 'no-product' })
    }),
    search: vi.fn(async () => ({ searchConfigured: true, candidates: [] })),
    device,
  }
  const catalog: CatalogEditor = { confirm: vi.fn(async () => {}), update: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  const user = userEvent.setup()
  render(
    <Dashboard
      data={data}
      source={{ source: 'local-file' }}
      overridesStore={createOverridesStore(new IDBFactory())}
      today="2026-01-15"
      photo={photo}
      catalog={catalog}
      {...(opts.identities ? { productIdentities: opts.identities } : {})}
    />,
  )
  return { user, device, photo, catalog }
}

const openSheet = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(within(screen.getByRole('navigation', { name: 'Dashboard sections' })).getByRole('button', { name: 'Items' }))
  await user.click(screen.getByRole('button', { name: 'Find item from photo' }))
  return await screen.findByRole('dialog', { name: 'Find an item from a photo' })
}
const choosePhoto = async (user: ReturnType<typeof userEvent.setup>, sheet: HTMLElement) =>
  user.upload(within(sheet).getByLabelText('Choose a photo of the item'), new File(['x'], 'IMG_0001.HEIC', { type: 'image/heic' }))

describe('photo matching: entry point and modal sheet', () => {
  it('appears only where photo matching is available (cloud), as a modal sheet with focus handled safely', async () => {
    space = mockAvailableWidth(COMPACT)
    const plain = render(<Dashboard data={data} source={{ source: 'local-file' }} overridesStore={createOverridesStore(new IDBFactory())} today="2026-01-15" />)
    await userEvent.setup().click(within(screen.getByRole('navigation', { name: 'Dashboard sections' })).getByRole('button', { name: 'Items' }))
    expect(screen.queryByRole('button', { name: 'Find item from photo' })).not.toBeInTheDocument()
    plain.unmount()
    space.restore()

    const { user } = setup()
    const sheet = await openSheet(user)
    expect(sheet).toHaveAttribute('aria-modal', 'true')
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Close' }))
    // Camera and library both reachable, with labelled inputs.
    expect(within(sheet).getByRole('button', { name: 'Take photo' })).toBeInTheDocument()
    expect(within(sheet).getByLabelText('Take a photo of the item')).toHaveAttribute('capture', 'environment')
    expect(within(sheet).getByLabelText('Choose a photo of the item')).not.toHaveAttribute('capture')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Find item from photo' }))
  })
})

describe('photo matching: deterministic evidence first', () => {
  it('an item number read on the device identifies the item with no AI and no search, and opens its detail', async () => {
    const olive = itemBy('KS OLIVE OIL 2L')
    const { user, photo, device } = setup({ read: { lines: ['KIRKLAND SIGNATURE', 'OLIVE OIL', `Item ${olive.itemNumber}`], barcodes: [] } })
    const sheet = await openSheet(user)
    await choosePhoto(user, sheet)
    expect(await within(sheet).findByText('This looks like your item')).toBeInTheDocument()
    expect(within(sheet).getByText(/Read on this device · numbers/)).toBeInTheDocument()
    expect(photo.evidence).not.toHaveBeenCalled()
    expect(photo.search).not.toHaveBeenCalled()
    expect(within(sheet).queryByRole('button', { name: 'Analyze photo with AI' })).not.toBeInTheDocument()
    const card = within(within(sheet).getByRole('list', { name: 'Matching items' })).getAllByRole('article')[0]!
    expect(card).toHaveTextContent(`Item #${olive.itemNumber}`)
    expect(card).toHaveTextContent('Strong match · 97%')
    expect(card).toHaveTextContent(/Bought \d+ times?/)
    await user.click(within(card).getByRole('button', { name: /This is it: open/ }))
    // The sheet closes and the item opens (a modal detail sheet in compact width) with the match noted.
    expect(screen.queryByRole('dialog', { name: 'Find an item from a photo' })).not.toBeInTheDocument()
    expect(await screen.findByTestId('photo-match-note')).toHaveTextContent('Opened from your photo: you confirmed this match (strong match, 97%).')
    expect(screen.getByTestId('detail')).toHaveAttribute('data-presentation', 'sheet')
    expect(device.release).toHaveBeenCalled()
  })

  it('at a split-capable width the matched item opens in the docked pane, beside the list', async () => {
    const olive = itemBy('KS OLIVE OIL 2L')
    const { user } = setup({ width: WIDE, read: { lines: [`ITEM ${olive.itemNumber}`], barcodes: [] } })
    const sheet = await openSheet(user)
    await choosePhoto(user, sheet)
    await user.click(await within(sheet).findByRole('button', { name: /This is it: open/ }))
    expect(screen.getByTestId('detail')).toHaveAttribute('data-presentation', 'pane')
    expect(screen.getByRole('region', { name: 'Items table' })).toBeInTheDocument()
  })

  it('a typed item number works without a photo', async () => {
    const eggs = itemBy('KS LARGE EGGS 24 CT')
    const { user, device } = setup()
    const sheet = await openSheet(user)
    await user.type(within(sheet).getByLabelText(/Or type the item number/), eggs.itemNumber)
    await user.click(within(sheet).getByRole('button', { name: 'Find' }))
    expect(await within(sheet).findByText('This looks like your item')).toBeInTheDocument()
    expect(within(sheet).getByText('Matched the text you typed.')).toBeInTheDocument()
    expect(device.prepare).not.toHaveBeenCalled()
  })
})

describe('photo matching: AI only on request, then search', () => {
  it('when the device cannot identify the item, the owner may send the photo — only the photo — to AI', async () => {
    const { user, photo } = setup({ read: { lines: ['NET WT'], barcodes: [] }, evidence: aiEvidence({ brand: 'Kirkland Signature', productName: 'Olive Oil', size: '2 L', visibleText: ['OLIVE OIL'] }) })
    const sheet = await openSheet(user)
    await choosePhoto(user, sheet)
    // Text was read, but nothing in it matches a purchase.
    expect(await within(sheet).findByText('No match in your purchases')).toBeInTheDocument()
    expect(photo.evidence).not.toHaveBeenCalled()
    await user.click(within(sheet).getByRole('button', { name: 'Analyze photo with AI' }))
    expect(photo.evidence).toHaveBeenCalledWith(DATA_URL)
    // Several different item numbers carry the same receipt text: honestly ambiguous, so the owner chooses.
    expect(await within(sheet).findByText('A few possible matches — choose the right one')).toBeInTheDocument()
    expect(within(sheet).getByText(/described by AI in your Cloudflare account/)).toBeInTheDocument()
    const cards = within(sheet).getAllByRole('article')
    expect(cards.length).toBeGreaterThan(1)
    for (const c of cards) expect(c).toHaveTextContent('KS OLIVE OIL 2L')
    expect(photo.search).not.toHaveBeenCalled() // strong local candidates need no search
  })

  it('a product not in the purchases is searched with generic product text only and shown as "not in your purchases"', async () => {
    const { user, photo } = setup({ read: { lines: [], barcodes: [] }, evidence: aiEvidence({ brand: 'Acme', productName: 'Garden Hose Reel', variant: 'Green', visibleText: ['ACME'] }) })
    vi.mocked(photo.search).mockResolvedValue({ searchConfigured: true, candidates: [{ itemNumber: '9876543', title: 'Acme Garden Hose Reel, Green', basis: 'costco-specialist' }] })
    const sheet = await openSheet(user)
    await choosePhoto(user, sheet)
    await user.click(await within(sheet).findByRole('button', { name: 'Analyze photo with AI' }))
    await waitFor(() => expect(photo.search).toHaveBeenCalledWith({ brand: 'Acme', productName: 'Garden Hose Reel', variant: 'Green' }))
    const card = await within(sheet).findByRole('article')
    expect(card).toHaveTextContent('Acme Garden Hose Reel, Green')
    expect(card).toHaveTextContent('Not in your purchases.')
    expect(within(card).queryByRole('button')).not.toBeInTheDocument()
  })

  it('failures are recoverable: unsupported photo, AI error', async () => {
    const bad = setup({ prepare: new PhotoInputError('unsupported', 'That file is not a photo. Choose a JPEG, PNG, WebP or HEIC image.') })
    let sheet = await openSheet(bad.user)
    await choosePhoto(bad.user, sheet)
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('That file is not a photo')
    expect(within(sheet).getByRole('button', { name: 'Choose photo' })).toBeInTheDocument()
    await bad.user.keyboard('{Escape}')
    document.body.innerHTML = ''
    space?.restore()

    const failing = setup({ read: { lines: [], barcodes: [] }, evidence: new Error('The photo could not be analyzed right now.') })
    sheet = await openSheet(failing.user)
    await choosePhoto(failing.user, sheet)
    await failing.user.click(await within(sheet).findByRole('button', { name: 'Analyze photo with AI' }))
    expect(await within(sheet).findByText(/Photo analysis failed: The photo could not be analyzed right now/)).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Take photo' })).toBeInTheDocument()
  })
})

describe('photo matching: confirmation never overwrites an identity', () => {
  it('an item without an identity can be saved through the owner-confirmed workflow; owner-confirmed items cannot be', async () => {
    const soap = itemBy('KS DISH SOAP PODS')
    const shampoo = itemBy('KS SHAMPOO 2 PK')
    const owner: ProductIdentity = {
      itemNumber: shampoo.itemNumber,
      status: 'resolved',
      receiptDescription: 'KS SHAMPOO 2 PK',
      canonicalName: 'Kirkland Signature Shampoo, 2-pack',
      brand: 'Kirkland Signature',
      productType: 'shampoo',
      confidence: 1,
      basis: 'owner-confirmed',
      method: 'owner',
      resolvedAt: '2026-01-01T00:00:00.000Z',
    }
    const { user, catalog } = setup({ read: { lines: [`#${soap.itemNumber}`, `#${shampoo.itemNumber}`], barcodes: [] }, identities: { [shampoo.itemNumber]: owner } })
    const sheet = await openSheet(user)
    await choosePhoto(user, sheet)
    const cards = await within(sheet).findAllByRole('article')
    const soapCard = cards.find((c) => c.textContent?.includes(soap.itemNumber))!
    const shampooCard = cards.find((c) => c.textContent?.includes(shampoo.itemNumber))!
    expect(within(shampooCard).getByText('Owner confirmed')).toBeInTheDocument()
    expect(within(shampooCard).queryByRole('button', { name: /Save .* as my product identity/ })).not.toBeInTheDocument()
    await user.click(within(soapCard).getByRole('button', { name: /Save .* as my product identity/ }))
    const form = within(sheet).getByRole('form', { name: /Product identity for/ })
    await user.clear(within(form).getByLabelText('Product name (required)'))
    await user.type(within(form).getByLabelText('Product name (required)'), 'Kirkland Signature Dish Soap Pods')
    await user.click(within(form).getByRole('button', { name: 'Save to my catalog' }))
    expect(catalog.confirm).toHaveBeenCalledWith(soap.itemNumber, 'KS DISH SOAP PODS', { canonicalName: 'Kirkland Signature Dish Soap Pods', brand: null, productType: null })
    expect(catalog.update).not.toHaveBeenCalled()
    expect(await screen.findByTestId('photo-match-note')).toBeInTheDocument()
  })
})
