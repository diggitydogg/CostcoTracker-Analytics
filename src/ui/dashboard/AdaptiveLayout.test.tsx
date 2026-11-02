import { IDBFactory } from 'fake-indexeddb'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateDataset } from '../../analytics/test/builder'
import type { ProductIdentity } from '../../analytics/products/identityProtocol'
import { createOverridesStore } from '../../persistence/overridesStore'
import { mockAvailableWidth } from '../../test/resize'
import type { CatalogEditor } from './context'
import { Dashboard } from './Dashboard'

/**
 * Representative widths (CSS px) of the space the dashboard gets. They are
 * NOT claims about any specific device: Apple publishes no web viewport sizes
 * for iPhone Duo, and layout here depends only on available width.
 */
const COMPACT_PHONE = 375 // a typical compact-width iPhone in portrait
const NARROW = 320 // the narrowest supported width (CLAUDE.md)
const REGULAR_NOT_SPLIT = 800 // regular width, but not room for two usable panes (e.g. a phone in landscape)
const SPLIT_MIN = 832 // 52rem at the default text size: the smallest region that docks the detail
const WIDE = 1180 // room for a list and a detail pane side by side

const SOURCE = { source: 'local-file' as const }
const dataset = () => generateDataset({ receipts: 40, itemsPerReceipt: 4, returns: 4, adjustments: 3, seed: 7 })

let space: ReturnType<typeof mockAvailableWidth> | null = null
afterEach(() => {
  space?.restore()
  space = null
})

function renderAt(width: number, extra: { catalog?: CatalogEditor; productIdentities?: Record<string, ProductIdentity> } = {}) {
  space = mockAvailableWidth(width)
  const user = userEvent.setup()
  const data = dataset()
  render(<Dashboard data={data} source={SOURCE} overridesStore={createOverridesStore(new IDBFactory())} today="2026-01-15" {...extra} />)
  return { user, data, resize: (w: number) => space!.resize(w) }
}

const tab = (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(within(screen.getByRole('navigation', { name: 'Dashboard sections' })).getByRole('button', { name }))
const layout = () => screen.getByTestId('dashboard-layout')
const detail = () => screen.getByTestId('detail')
const itemButtons = () => within(screen.getByRole('region', { name: 'Items table' })).getAllByRole('button', { name: /#/ })

describe('adaptive layout: compact width', () => {
  it('keeps the single-column dashboard and presents detail as a modal sheet', async () => {
    const { user } = renderAt(COMPACT_PHONE)
    expect(layout()).toHaveAttribute('data-layout', 'single')
    await tab(user, 'Items')
    await user.click(itemButtons()[0]!)
    expect(layout()).toHaveAttribute('data-layout', 'single')
    expect(detail()).toHaveAttribute('data-presentation', 'sheet')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
  })

  it('stays a sheet at regular width when two panes would not be legible', async () => {
    const { user } = renderAt(REGULAR_NOT_SPLIT)
    await tab(user, 'Items')
    await user.click(itemButtons()[0]!)
    expect(detail()).toHaveAttribute('data-presentation', 'sheet')
  })
})

describe('adaptive layout: split threshold', () => {
  const presentationAt = async (width: number) => {
    const { user } = renderAt(width)
    await tab(user, 'Items')
    await user.click(itemButtons()[0]!)
    return detail().getAttribute('data-presentation')
  }

  it('docks the detail from exactly the split width, and keeps the sheet just below it', async () => {
    expect(await presentationAt(SPLIT_MIN - 1)).toBe('sheet')
  })

  it('docks at the split width', async () => {
    expect(await presentationAt(SPLIT_MIN)).toBe('pane')
  })

  it('larger text pushes the same width back to a sheet when two readable panes no longer fit', async () => {
    document.documentElement.style.fontSize = '200%'
    try {
      // 1180px is a pane at the default text size, but at 200% the split needs 104rem = 1664px.
      expect(await presentationAt(WIDE)).toBe('sheet')
    } finally {
      document.documentElement.style.fontSize = ''
    }
  })
})

describe('adaptive layout: wide (split) width', () => {
  it('docks the detail beside the list as a non-modal pane and highlights the selection', async () => {
    const { user } = renderAt(WIDE)
    await tab(user, 'Items')
    const first = itemButtons()[0]!
    await user.click(first)
    expect(layout()).toHaveAttribute('data-layout', 'split')
    expect(detail()).toHaveAttribute('data-presentation', 'pane')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const pane = detail().querySelector(':scope > [aria-labelledby="drill-title"]')
    expect(pane).toHaveAttribute('role', 'region')
    expect(pane).not.toHaveAttribute('aria-modal')
    // The list stays usable, and the selected row is marked.
    expect(first.closest('tr')).toHaveAttribute('aria-current', 'true')
    // Selecting another row replaces the detail (a split view's primary list), with no stacked Back.
    await user.click(itemButtons()[1]!)
    expect(first.closest('tr')).not.toHaveAttribute('aria-current')
    expect(itemButtons()[1]!.closest('tr')).toHaveAttribute('aria-current', 'true')
    expect(within(detail()).queryByRole('button', { name: '← Back' })).not.toBeInTheDocument()
    // Closing the pane returns to the single layout.
    await user.click(within(detail()).getByRole('button', { name: 'Close' }))
    expect(layout()).toHaveAttribute('data-layout', 'single')
  })

  it('Escape closes a docked pane only when focus is inside it', async () => {
    const { user } = renderAt(WIDE)
    await tab(user, 'Items')
    await user.click(itemButtons()[0]!)
    screen.getByRole('searchbox').focus()
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('detail')).toBeInTheDocument()
    within(detail()).getByRole('button', { name: 'Close' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument()
  })
})

describe('adaptive layout: focus never scrolls the page', () => {
  /** Every programmatic focus the dashboard makes, with its target and options. */
  function spyFocus() {
    const calls: { el: HTMLElement; options: FocusOptions | undefined }[] = []
    const original = HTMLElement.prototype.focus
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      calls.push({ el: this, options })
      return original.call(this, options)
    })
    return { calls, spy, ours: () => calls.filter((c) => c.options !== undefined) }
  }

  it('pane: selecting other rows by pointer leaves focus in the list, and closing never returns to the first row', async () => {
    const { user } = renderAt(WIDE)
    await tab(user, 'Items')
    const rows = itemButtons()
    const focus = spyFocus()
    await user.click(rows[2]!)
    expect(detail()).toHaveAttribute('data-presentation', 'pane')
    await user.click(rows[9]!)
    await user.click(rows[12]!)
    // Nothing focused inside the pane: Safari would scroll the page to reveal it.
    expect(focus.ours().filter((c) => detail().contains(c.el))).toEqual([])
    expect(document.activeElement).not.toBe(within(detail()).getByRole('button', { name: 'Close' }))
    // The pane's own scroll still starts at the top for each new item (it is the pane, not the page).
    await user.click(within(detail()).getByRole('button', { name: 'Close' }))
    // Focus goes to the row of the current selection — never back to the row that first opened the pane.
    expect(document.activeElement).toBe(rows[12])
    expect(document.activeElement).not.toBe(rows[2])
    for (const c of focus.ours()) expect(c.options).toEqual({ preventScroll: true })
    focus.spy.mockRestore()
  })

  it('pane: a keyboard selection moves focus into the pane, and Escape returns it to that row', async () => {
    const { user } = renderAt(WIDE)
    await tab(user, 'Items')
    const rows = itemButtons()
    const focus = spyFocus()
    rows[5]!.focus()
    await user.keyboard('{Enter}')
    expect(detail()).toHaveAttribute('data-presentation', 'pane')
    expect(document.activeElement).toBe(within(detail()).getByRole('button', { name: 'Close' }))
    // Tab stays usable inside the pane; Escape (focus inside) closes it.
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(rows[5])
    for (const c of focus.ours()) expect(c.options).toEqual({ preventScroll: true })
    focus.spy.mockRestore()
  })

  it('sheet: dialog focus is unchanged — Close is focused on open and focus returns to the opener on close', async () => {
    const { user } = renderAt(COMPACT_PHONE)
    await tab(user, 'Items')
    const rows = itemButtons()
    const focus = spyFocus()
    await user.click(rows[7]!)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(document.activeElement).toBe(within(detail()).getByRole('button', { name: 'Close' }))
    await user.click(within(detail()).getByRole('button', { name: 'Close' }))
    expect(document.activeElement).toBe(rows[7])
    // Backdrop and Escape close the same way.
    await user.click(rows[3]!)
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(rows[3])
    expect(focus.ours().length).toBeGreaterThan(0)
    for (const c of focus.ours()) expect(c.options).toEqual({ preventScroll: true })
    focus.spy.mockRestore()
  })

  it('a pane that becomes a modal sheet when space shrinks takes focus into the dialog', async () => {
    const { user, resize } = renderAt(WIDE)
    await tab(user, 'Items')
    await user.click(itemButtons()[1]!)
    expect(detail().contains(document.activeElement)).toBe(false)
    resize(COMPACT_PHONE)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(detail().contains(document.activeElement)).toBe(true)
  })
})

describe('adaptive layout: resizing and rotation keep state', () => {
  it('keeps the selected item, search and filters through compact ↔ wide changes', async () => {
    const { user, resize } = renderAt(WIDE)
    await tab(user, 'Items')
    const search = screen.getByRole('searchbox')
    await user.type(search, '1')
    await user.click(within(screen.getByRole('radiogroup', { name: 'Purchase pattern' })).getAllByRole('radio')[1]!)
    const checked = within(screen.getByRole('radiogroup', { name: 'Purchase pattern' })).getByRole('radio', { checked: true }).textContent
    const countText = screen.getByTestId('item-count').textContent
    const row = itemButtons()[0]!
    const name = row.querySelector('span')!.textContent!
    await user.click(row)
    expect(detail()).toHaveAttribute('data-presentation', 'pane')

    // Close the foldable / rotate to a compact width: same detail, now as a sheet.
    resize(COMPACT_PHONE)
    expect(detail()).toHaveAttribute('data-presentation', 'sheet')
    expect(within(detail()).getByRole('heading', { level: 2 })).toHaveTextContent(name)
    // Then wide again (e.g. landscape-like geometry): still the same item, back in the pane.
    resize(WIDE)
    expect(detail()).toHaveAttribute('data-presentation', 'pane')
    expect(within(detail()).getByRole('heading', { level: 2 })).toHaveTextContent(name)

    // The list was never reset.
    expect(screen.getByRole('searchbox')).toHaveValue('1')
    expect(within(screen.getByRole('radiogroup', { name: 'Purchase pattern' })).getByRole('radio', { checked: true }).textContent).toBe(checked)
    expect(screen.getByTestId('item-count').textContent).toBe(countText)
    expect(screen.getByRole('navigation', { name: 'Dashboard sections' }).querySelector('[aria-current="page"]')).toHaveTextContent('Items')
  })

  it('keeps a drill-down stack (Back) through a resize, and stays usable', async () => {
    const { user, resize } = renderAt(COMPACT_PHONE)
    await tab(user, 'Items')
    await user.click(itemButtons()[0]!)
    // Drill further from inside the detail: a purchase.
    const purchases = within(detail()).getByRole('region', { name: 'Purchases' })
    await user.click(within(purchases).getAllByRole('button')[0]!)
    expect(within(detail()).getByRole('button', { name: '← Back' })).toBeInTheDocument()
    resize(WIDE)
    expect(detail()).toHaveAttribute('data-presentation', 'pane')
    await user.click(within(detail()).getByRole('button', { name: '← Back' }))
    expect(within(detail()).queryByRole('button', { name: '← Back' })).not.toBeInTheDocument()
    resize(NARROW)
    await user.click(within(detail()).getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument()
  })

  it('keeps an open owner-confirmed identity form and its unsaved input across width changes', async () => {
    const catalog: CatalogEditor = { confirm: vi.fn(async () => {}), update: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const { user, resize } = renderAt(COMPACT_PHONE, { catalog })
    await tab(user, 'Items')
    await user.click(itemButtons()[0]!)
    await user.click(within(detail()).getByRole('button', { name: 'Confirm identity' }))
    const form = within(detail()).getByRole('form', { name: /Product identity for/ })
    // The form adapts to its own width (a narrow cell, a pane, a sheet), not the window's.
    expect(form).toHaveClass('@container')
    await user.type(within(form).getByLabelText('Product name (required)'), 'Synthetic Typed Name')
    await user.type(within(form).getByLabelText('Brand (optional)'), 'Synthetic')
    resize(WIDE)
    expect(detail()).toHaveAttribute('data-presentation', 'pane')
    resize(COMPACT_PHONE)
    const after = within(detail()).getByRole('form', { name: /Product identity for/ })
    expect(within(after).getByLabelText('Product name (required)')).toHaveValue('Synthetic Typed Name')
    expect(within(after).getByLabelText('Brand (optional)')).toHaveValue('Synthetic')
    expect(catalog.confirm).not.toHaveBeenCalled()
  })
})

describe('adaptive layout: behavior is unchanged by width', () => {
  it('automatic identities stay read-only and categories are identical at compact and wide widths', async () => {
    const data = dataset()
    const itemNumber = data.items[0]!.itemNumber
    const identity: ProductIdentity = {
      itemNumber,
      status: 'resolved',
      receiptDescription: data.items[0]!.description,
      canonicalName: 'Synthetic Automatic Product',
      brand: null,
      productType: null,
      confidence: 0.9,
      basis: 'costco.com',
      method: 'web-search',
      resolvedAt: '2026-01-01T00:00:00.000Z',
    }
    const catalog: CatalogEditor = { confirm: vi.fn(), update: vi.fn(), remove: vi.fn() }
    const categoriesAt = async (width: number) => {
      space = mockAvailableWidth(width)
      const user = userEvent.setup()
      const view = render(<Dashboard data={data} source={SOURCE} overridesStore={createOverridesStore(new IDBFactory())} today="2026-01-15" catalog={catalog} productIdentities={{ [itemNumber]: identity }} />)
      await tab(user, 'Items')
      await user.type(screen.getByRole('searchbox'), itemNumber)
      await user.click(itemButtons()[0]!)
      const d = detail()
      expect(within(d).getByTestId('product-identity')).toHaveTextContent("resolved from Costco's own page")
      for (const name of ['Edit identity', 'Remove identity', 'Confirm identity']) expect(within(d).queryByRole('button', { name })).not.toBeInTheDocument()
      const category = within(d).getByRole('region', { name: 'Category' }).textContent
      view.unmount()
      space.restore()
      space = null
      return category
    }
    expect(await categoriesAt(COMPACT_PHONE)).toBe(await categoriesAt(WIDE))
  })

  it.each([
    ['narrow', NARROW],
    ['compact', COMPACT_PHONE],
    ['wide', WIDE],
  ])('renders every analytics section at %s width without broken text', async (_label, width) => {
    const { user } = renderAt(width)
    for (const name of ['Overview', 'Items', 'Price index', 'Categories', 'Returns & adjustments', 'Warehouses']) {
      await tab(user, name)
      expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0)
      expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined|\bnull\b/)
    }
  })
})

describe('adaptive layout: text growth', () => {
  it('a sheet title wraps instead of clipping at large text sizes', async () => {
    const { user } = renderAt(NARROW)
    await tab(user, 'Items')
    await user.click(itemButtons()[0]!)
    const title = within(detail()).getByRole('heading', { level: 2 })
    expect(title).toHaveClass('line-clamp-2')
    expect(title).not.toHaveClass('truncate')
  })
})
