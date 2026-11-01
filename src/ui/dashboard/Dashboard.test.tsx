import { IDBFactory } from 'fake-indexeddb'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAnalyticsSnapshot } from '../../analytics'
import { DatasetBuilder, generateDataset } from '../../analytics/test/builder'
import type { AnalyticsExportV1 } from '../../domain/export/v1'
import { createOverridesStore, type OverridesStore } from '../../persistence/overridesStore'
import { Dashboard } from './Dashboard'
import { count, money, moneyWhole, share } from './format'

const SOURCE = { source: 'local-file' as const }
const TABS = ['Overview', 'Items', 'Price index', 'Categories', 'Returns & adjustments', 'Warehouses']

function renderDashboard(data: AnalyticsExportV1, store: OverridesStore = createOverridesStore(new IDBFactory())) {
  const user = userEvent.setup()
  const view = render(<Dashboard data={data} source={SOURCE} overridesStore={store} today="2026-01-15" />)
  return { user, store, ...view }
}

const tab = (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(within(screen.getByRole('navigation', { name: 'Dashboard sections' })).getByRole('button', { name }))

/** Visible text must never contain NaN, Infinity or "undefined"/"null". */
function expectCleanText() {
  const text = document.body.textContent ?? ''
  expect(text).not.toMatch(/NaN|Infinity|undefined|\bnull\b/)
}

const dataset = () => generateDataset({ receipts: 70, itemsPerReceipt: 5, returns: 8, adjustments: 5, seed: 13 })

/** Five items whose prices are recorded in 2022 and 2023, plus unmatched spend controlling coverage. */
function inflationData(unmatchedCents: number, matchedItems = 5) {
  const b = new DatasetBuilder()
  for (const item of ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, matchedItems)) {
    b.buy('2022-02-01', item, 1000)
    b.buy('2023-02-01', item, 1100)
  }
  if (unmatchedCents > 0) {
    b.buy('2022-03-01', 'BIG1', unmatchedCents)
    b.buy('2023-03-01', 'BIG2', unmatchedCents)
  }
  return b.build()
}

/** The headline value of a stat card, found by its label. */
function cardValue(label: string, root: HTMLElement = document.body) {
  return within(root).getByText(label, { selector: 'span' }).closest('div')!.querySelector('dd')!.textContent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dashboard overview', () => {
  it('shows summary cards that match the engine, with pre-tax wording', async () => {
    const data = dataset()
    renderDashboard(data)
    const s = buildAnalyticsSnapshot(data)
    const summary = screen.getByLabelText('Summary')
    expect(cardValue('Net Costco spend', summary)).toBe(moneyWhole(s.spending.lifetime.netCents))
    expect(cardValue('Gross purchases', summary)).toBe(moneyWhole(s.spending.lifetime.grossCents))
    expect(cardValue('Returns', summary)).toBe(moneyWhole(s.spending.lifetime.refundCents))
    expect(cardValue('Price adjustments recovered', summary)).toBe(moneyWhole(s.spending.lifetime.adjustmentCents))
    expect(cardValue('Purchases', summary)).toBe(count(s.trips.eventCount))
    expect(cardValue('Average basket', summary)).toBe(money(s.trips.basket.averageCents))
    expect(s.spending.lifetime.netCents).toBe(s.spending.lifetime.grossCents - s.spending.lifetime.refundCents - s.spending.lifetime.adjustmentCents)
    expect(screen.getByTestId('data-range')).toHaveTextContent('Pre-tax merchandise totals')
    expect(summary).toHaveTextContent(`${share(s.returns.observedReturnValueRatio)} of observed spend`)
    expectCleanText()
  })

  it('switches the cards to the last 12 months with a comparison only where comparable', async () => {
    const data = dataset()
    const { user } = renderDashboard(data)
    const s = buildAnalyticsSnapshot(data)
    await user.click(screen.getByRole('radio', { name: 'Last 12 months' }))
    const summary = screen.getByLabelText('Summary')
    expect(cardValue('Gross purchases', summary)).toBe(moneyWhole(s.spending.rolling12.grossCents))
    expect(summary).toHaveTextContent(/vs previous 12 months/)
    const year = s.spending.yearly.filter((y) => y.complete).at(-1)!
    await user.click(screen.getByRole('radio', { name: String(year.year) }))
    expect(cardValue('Gross purchases', summary)).toBe(moneyWhole(year.grossCents))
    expectCleanText()
  })

  it('drills from a chart month to its records and on to a purchase and an item', async () => {
    const data = dataset()
    const { user } = renderDashboard(data)
    const s = buildAnalyticsSnapshot(data)
    const last = s.spending.monthly.at(-1)!
    const chart = screen.getByRole('region', { name: 'Monthly spending' })
    await user.click(within(chart).getByRole('button', { name: /^Records for/ }))
    const dialog = screen.getByRole('dialog')
    const purchases = within(dialog).getByRole('region', { name: /^Purchases \(/ })
    expect(purchases).toHaveTextContent(`Purchases (${last.receiptIds.length})`)
    await user.click(within(purchases).getAllByRole('button')[0]!)
    const items = within(screen.getByRole('dialog')).getByRole('region', { name: 'Items' })
    expect(items).toHaveTextContent('Total of exported lines')
    await user.click(within(items).getAllByRole('button')[0]!)
    expect(within(screen.getByRole('dialog')).getByRole('region', { name: 'Price history' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(within(screen.getByRole('dialog')).getByRole('region', { name: 'Items' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('moves through months with the keyboard and shows exact values', async () => {
    const data = dataset()
    const { user } = renderDashboard(data)
    const s = buildAnalyticsSnapshot(data)
    const chart = screen.getByRole('group', { name: /Monthly spending chart/ })
    const readout = within(screen.getByRole('region', { name: 'Monthly spending' })).getByTestId('chart-readout')
    const months = s.spending.monthly.slice(-24)
    expect(readout).toHaveTextContent(`Purchases${money(months.at(-1)!.grossCents)}`)
    chart.focus()
    await user.keyboard('{ArrowLeft}')
    expect(readout).toHaveTextContent(`Purchases${money(months.at(-2)!.grossCents)}`)
    await user.keyboard('{Home}')
    expect(readout).toHaveTextContent(`Purchases${money(months[0]!.grossCents)}`)
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('empty and sparse data', () => {
  it('renders an empty dataset without errors', async () => {
    const { user } = renderDashboard(new DatasetBuilder().build())
    expect(screen.getByText(/There is no purchase data yet/)).toBeInTheDocument()
    for (const t of TABS) await tab(user, t)
    expectCleanText()
  })

  it('renders every section for a single undated receipt and a lone return', async () => {
    const b = new DatasetBuilder()
    b.buy(null, 'X', null, 1, { lineTotalCents: 500 })
    b.ret({ itemNumber: 'Y', date: null, amountCents: null })
    const { user } = renderDashboard(b.build())
    for (const t of TABS) {
      await tab(user, t)
      expectCleanText()
    }
  })

  it('renders every section and drawer for sparse dated data', async () => {
    const b = new DatasetBuilder()
    b.buy('2025-06-01', 'A', 1299, 2, { description: 'KS PAPER TOWELS' })
    b.buy('2025-06-20', 'B', null, 1.25, { lineTotalCents: 777, description: 'GROUND BEEF' })
    b.adj({ itemNumber: 'A', date: '2025-06-25', amountCents: 200 })
    const { user } = renderDashboard(b.build())
    for (const t of TABS) {
      await tab(user, t)
      expectCleanText()
    }
    await tab(user, 'Items')
    await user.click(screen.getByRole('button', { name: /GROUND BEEF/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('region', { name: 'Price history' })).toHaveTextContent('No recorded unit price for this item (1 lines without a unit price)')
    expect(within(dialog).getByRole('region', { name: 'Purchases' })).toHaveTextContent('not recorded')
    expectCleanText()
  })
})

describe('personal price index', () => {
  it.each([
    ['reliable', 0, 1, 'Reliable'],
    ['low-coverage', 4500 * 10, 1, 'Low coverage'],
    ['insufficient', 0, 0, 'Insufficient data'],
  ] as const)('shows the %s confidence state and still shows the number', async (_, unmatched, enough, label) => {
    const { user } = renderDashboard(inflationData(unmatched, enough ? 5 : 2))
    await tab(user, 'Price index')
    const cards = screen.getAllByText(/Your basket|Matched items, same years/)
    expect(cards.length).toBeGreaterThan(0)
    const table = screen.getByRole('region', { name: 'Price index links table' })
    expect(within(table).getByText(label)).toBeInTheDocument()
    // The simple index value is shown even when confidence is low.
    expect(screen.getByText('Matched items, same years').closest('div')).toHaveTextContent('+10.0%')
    if (label !== 'Reliable') expect(screen.getByRole('note')).toHaveTextContent(label === 'Low coverage' ? 'Low coverage' : 'Insufficient')
    else expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\bCPI\b(?!\))/) // only mentioned as "not … (CPI)"
    expect(screen.getByText(/not an official inflation figure/)).toBeInTheDocument()
    expectCleanText()
  })

  it('opens the matched items behind a year-to-year change', async () => {
    const { user } = renderDashboard(inflationData(0))
    await tab(user, 'Price index')
    await user.click(screen.getByRole('button', { name: '2022 → 2023' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('region', { name: 'Matched items table' }).querySelectorAll('tbody tr')).toHaveLength(5)
  })
})

describe('returns and adjustments terminology', () => {
  it('uses observed-spend wording and never claims a return or savings rate', async () => {
    const { user } = renderDashboard(dataset())
    await tab(user, 'Returns & adjustments')
    expect(screen.getByText('Returns as % of observed spend')).toBeInTheDocument()
    expect(screen.getByText('Price adjustments as % of observed spend')).toBeInTheDocument()
    expect(screen.getByTestId('returns-linkage')).toHaveTextContent('a true return rate is not available')
    expect(screen.getByTestId('returns-linkage')).toHaveTextContent('Time from purchase to return is not available')
    expect(screen.getByTestId('adjustments-linkage')).toHaveTextContent('a true savings rate is not available')
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/Return rate|Dollar return rate|Savings rate/)
    expectCleanText()
  })
})

describe('item explorer', () => {
  it('searches, filters by pattern and sorts', async () => {
    const data = dataset()
    const s = buildAnalyticsSnapshot(data)
    const { user } = renderDashboard(data)
    await tab(user, 'Items')
    expect(screen.getByTestId('item-count')).toHaveTextContent(`${s.items.items.length} items`)
    await user.click(screen.getByRole('radio', { name: new RegExp(`^Staples ${s.items.cohorts.staple.length}$`) }))
    expect(screen.getByTestId('item-count')).toHaveTextContent(`${s.items.cohorts.staple.length} item`)
    await user.click(screen.getByRole('radio', { name: /^All / }))
    await user.type(screen.getByRole('searchbox', { name: 'Search items' }), 'paper towels')
    await waitFor(() => {
      const rows = within(screen.getByRole('region', { name: 'Items table' })).getAllByRole('row').slice(1)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(r).toHaveTextContent(/PAPER TOWELS/)
    })
    await user.clear(screen.getByRole('searchbox', { name: 'Search items' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search items' }), 'no such thing')
    expect(await screen.findByText('No items match.')).toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox', { name: 'Search items' }))
    const header = screen.getByRole('columnheader', { name: /Total spend/ })
    expect(header).toHaveAttribute('aria-sort', 'descending')
    await user.click(within(header).getByRole('button'))
    expect(header).toHaveAttribute('aria-sort', 'ascending')
  })

  it('shows item detail with stats and a price history point per recorded price day', async () => {
    const data = dataset()
    const s = buildAnalyticsSnapshot(data)
    const top = s.items.topBySpend.map((n) => s.items.byItemNumber.get(n)!).find((i) => s.items.priceHistories.get(i.itemNumber)!.points.length >= 3)!
    const history = s.items.priceHistories.get(top.itemNumber)!
    const { user } = renderDashboard(data)
    await tab(user, 'Items')
    await user.click(within(screen.getByRole('region', { name: 'Items table' })).getAllByRole('button', { name: new RegExp(top.displayDescription) })[0]!)
    const dialog = screen.getByRole('dialog', { name: top.displayDescription })
    expect(within(dialog).getByText(`Item #${top.itemNumber}`, { exact: false })).toBeInTheDocument()
    expect(cardValue('Total spend', dialog)).toBe(money(top.totalSpentCents))
    expect(cardValue('Purchases', dialog)).toBe(count(top.purchaseEvents))
    const chart = within(dialog).getByRole('group', { name: /Unit price history/ })
    expect(chart.querySelectorAll('circle')).toHaveLength(history.points.length)
    const prices = within(dialog).getByRole('region', { name: 'Price history' })
    expect(prices).toHaveTextContent(`Lowest${money(history.minCents)}`)
    expect(prices).toHaveTextContent(`Highest${money(history.maxCents)}`)
    expect(prices).toHaveTextContent(`Latest${money(history.latestCents)}`)
    expectCleanText()
  })
})

describe('category overrides', () => {
  it('applies an override immediately, marks it, persists it locally and can undo it', async () => {
    const data = dataset()
    const s = buildAnalyticsSnapshot(data)
    const item = s.items.byItemNumber.get(s.items.topBySpend[0]!)!
    expect(item.category.categoryId).not.toBe('automotive')
    const store = createOverridesStore(new IDBFactory())
    const { user, unmount } = renderDashboard(data, store)
    await tab(user, 'Items')
    await user.click(within(screen.getByRole('region', { name: 'Items table' })).getAllByRole('button', { name: new RegExp(item.displayDescription) })[0]!)
    const panel = within(screen.getByRole('dialog')).getByRole('region', { name: 'Category' })
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Category' }), 'automotive')
    await user.click(within(panel).getByRole('button', { name: 'Save category' }))
    expect(within(screen.getByRole('dialog')).getByTestId('category-current')).toHaveTextContent('AutomotiveSet manually')
    await waitFor(async () => expect(await store.load()).toEqual({ status: 'loaded', overrides: { [item.itemNumber]: { categoryId: 'automotive', subcategoryId: null } } }))
    await user.keyboard('{Escape}')
    const row = within(screen.getByRole('region', { name: 'Items table' })).getAllByRole('button', { name: new RegExp(item.displayDescription) })[0]!
    expect(row).toHaveTextContent('Automotive')
    expect(row).toHaveTextContent('Manual')
    // Category totals follow the override (Σ categories still = gross).
    await tab(user, 'Categories')
    expect(screen.getByRole('button', { name: /^Automotive,/ })).toBeInTheDocument()
    unmount()

    // A new visit restores the override from this browser.
    const again = renderDashboard(data, store)
    await tab(again.user, 'Items')
    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: 'Items table' })).getAllByRole('button', { name: new RegExp(item.displayDescription) })[0]!).toHaveTextContent('Manual'),
    )
    await again.user.click(within(screen.getByRole('region', { name: 'Items table' })).getAllByRole('button', { name: new RegExp(item.displayDescription) })[0]!)
    await again.user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Use automatic category' }))
    expect(within(screen.getByRole('dialog')).getByTestId('category-current')).toHaveTextContent('Automatic')
    await waitFor(async () => expect(await store.load()).toEqual({ status: 'loaded', overrides: {} }))
  })

  it('keeps working for this tab when the browser cannot store overrides', async () => {
    const data = dataset()
    const s = buildAnalyticsSnapshot(data)
    const item = s.items.byItemNumber.get(s.items.topBySpend[0]!)!
    const { user } = renderDashboard(data, createOverridesStore(null))
    await tab(user, 'Items')
    await user.click(within(screen.getByRole('region', { name: 'Items table' })).getAllByRole('button', { name: new RegExp(item.displayDescription) })[0]!)
    const panel = within(screen.getByRole('dialog')).getByRole('region', { name: 'Category' })
    expect(panel).toHaveTextContent('applies in this tab only')
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Category' }), 'pet')
    await user.click(within(panel).getByRole('button', { name: 'Save category' }))
    expect(within(screen.getByRole('dialog')).getByTestId('category-current')).toHaveTextContent('PetSet manually')
  })
})

describe('warehouses', () => {
  it('lists placeholder warehouses explicitly and drills into a location', async () => {
    const data = dataset()
    const s = buildAnalyticsSnapshot(data)
    const { user } = renderDashboard(data)
    await tab(user, 'Warehouses')
    const table = screen.getByRole('region', { name: 'Locations table' })
    expect(within(table).getAllByRole('row')).toHaveLength(s.warehouses.groups.length + 1)
    expect(table).toHaveTextContent('Name not recorded')
    const g = s.warehouses.groups[0]!
    await user.click(within(table).getByRole('button', { name: g.label }))
    expect(within(screen.getByRole('dialog')).getByRole('region', { name: /^Purchases \(/ })).toHaveTextContent(`Purchases (${g.events})`)
  })
})

describe('responsive charts', () => {
  it('draws charts at the measured container width', async () => {
    let callback: ResizeObserverCallback | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          callback = cb
        }
        observe() {}
        disconnect() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 0, top: 0, left: 0, right: 320, bottom: 0, x: 0, y: 0, toJSON() {} })
    renderDashboard(dataset())
    const svg = screen.getByRole('group', { name: /Monthly spending chart/ })
    expect(svg).toHaveAttribute('width', '320')
    expect(callback).not.toBeNull()
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 900, height: 0, top: 0, left: 0, right: 900, bottom: 0, x: 0, y: 0, toJSON() {} })
    act(() => callback!([], {} as ResizeObserver))
    expect(svg).toHaveAttribute('width', '900')
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore()
  })

  it('wraps wide tables in horizontally scrollable regions', async () => {
    const { user } = renderDashboard(dataset())
    await tab(user, 'Items')
    expect(screen.getByRole('region', { name: 'Items table' })).toHaveClass('overflow-x-auto')
  })
})
