import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildAnalyticsSnapshot, categorize } from '../../analytics'
import type { SuggestRequestItem, SuggestResponse } from '../../analytics/categories/suggestProtocol'
import { DatasetBuilder } from '../../analytics/test/builder'
import { createOverridesStore, type OverridesStore } from '../../persistence/overridesStore'
import { Dashboard } from './Dashboard'
import type { BatchCategorySuggester } from './useSuggestionSession'

const SOURCE = { source: 'cloud' as const }

/** Synthetic data: some items match rules, some are Uncategorized, one has a manual override. */
function data(extraUncategorized = 0) {
  const b = new DatasetBuilder()
  const buy = (n: string, d: string, cents = 1000) => b.buy('2026-03-01', n, cents, 1, { description: d })
  buy('100', 'KS PAPER TOWELS 12 ROLL') // rule: paper goods
  buy('101', 'ANKERSOLIX', 49_999)
  buy('102', 'KS CHIANTI', 1_299)
  buy('103', 'CLASSIC BLUE', 2_000)
  buy('104', 'BLUEAIR RSV', 30_000)
  buy('105', 'TORO BULLY', 500) // owner already chose a category
  for (let i = 0; i < extraUncategorized; i++) buy(String(2000 + i), `MYSTERY THING ${i}`, 100 + i)
  return b.build()
}

const ANSWERS: Record<string, Omit<SuggestResponse['suggestions'][number], 'itemNumber'>> = {
  '101': { categoryId: 'electronics', subcategoryId: null, confidence: 0.93, reason: 'Anker Solix power station' },
  '102': { categoryId: 'alcohol', subcategoryId: null, confidence: 0.9, reason: 'Kirkland Signature Chianti wine' },
  '103': { categoryId: null, subcategoryId: null, confidence: 0, reason: 'Color name; product unknown' },
  '104': { categoryId: 'home', subcategoryId: null, confidence: 0.6, reason: 'Blueair air purifier' },
}

function suggester(impl?: (items: SuggestRequestItem[], call: number) => Promise<SuggestResponse>) {
  let call = 0
  return vi.fn<BatchCategorySuggester>(async (items) => {
    call += 1
    if (impl) return impl(items, call)
    return {
      model: 'test-model',
      suggestions: items.map((i) => ({ itemNumber: i.itemNumber, ...(ANSWERS[i.itemNumber] ?? { categoryId: null, subcategoryId: null, confidence: 0, reason: 'unknown' }) })),
    }
  })
}

async function setup(opts: { fn?: ReturnType<typeof suggester>; extra?: number; store?: OverridesStore; local?: boolean } = {}) {
  const store = opts.store ?? createOverridesStore(new IDBFactory())
  await store.save({ '105': { categoryId: 'home', subcategoryId: null } })
  const user = userEvent.setup()
  const fn = opts.fn ?? suggester()
  render(
    <Dashboard
      data={data(opts.extra)}
      source={SOURCE}
      overridesStore={store}
      today="2026-04-01"
      initialTab="categories"
      {...(opts.local ? {} : { suggester: fn })}
    />,
  )
  // Wait for the stored override to load (item 105 leaves Uncategorized).
  await waitFor(() => expect(screen.getByRole('region', { name: 'Uncategorized items' })).not.toHaveTextContent('TORO BULLY'))
  return { user, store, fn }
}

const panel = () => screen.getByRole('region', { name: 'AI category suggestions' })
const runButton = () => within(panel()).getByRole('button', { name: /Suggest categories with AI|Suggesting/ })
const uncategorizedText = () => screen.getByRole('region', { name: 'Uncategorized items' }).textContent ?? ''
const row = (n: string) => screen.getByTestId(`suggestion-${n}`)

describe('AI category suggestions — review workflow', () => {
  it('sends only automatically-Uncategorized items, with only item numbers and descriptions', async () => {
    const { user, fn } = await setup()
    expect(fn).not.toHaveBeenCalled() // never automatic
    await user.click(runButton())
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    const sent = fn.mock.calls[0]![0]
    // Highest spend first; rule-matched (100) and owner-overridden (105) items are never sent.
    expect(sent).toEqual([
      { itemNumber: '101', descriptions: ['ANKERSOLIX'] },
      { itemNumber: '104', descriptions: ['BLUEAIR RSV'] },
      { itemNumber: '103', descriptions: ['CLASSIC BLUE'] },
      { itemNumber: '102', descriptions: ['KS CHIANTI'] },
    ])
    for (const item of sent) expect(Object.keys(item).sort()).toEqual(['descriptions', 'itemNumber'])
  })

  it('shows suggestions without changing analytics or saving anything until accepted', async () => {
    const { user, store } = await setup()
    const before = uncategorizedText()
    await user.click(runButton())
    expect(await screen.findByTestId('suggestion-101')).toHaveTextContent('Electronics')
    expect(row('101')).toHaveTextContent('93%')
    expect(row('101')).toHaveTextContent('High')
    expect(row('101')).toHaveTextContent('Anker Solix power station')
    expect(row('101')).toHaveTextContent('#101')
    expect(row('103')).toHaveTextContent('No suggestion (AI abstained)')
    expect(within(row('103')).getByRole('button', { name: /Accept/ })).toBeDisabled()
    expect(uncategorizedText()).toBe(before)
    expect(await store.load()).toEqual({ status: 'loaded', overrides: { '105': { categoryId: 'home', subcategoryId: null } } })
  })

  it('Accept writes exactly the override a manual choice writes', async () => {
    const { user, store } = await setup()
    await user.click(runButton())
    await user.click(await within(await screen.findByTestId('suggestion-101')).findByRole('button', { name: /Accept/ }))
    await waitFor(async () => expect(((await store.load()) as { overrides: object }).overrides).toMatchObject({ '101': { categoryId: 'electronics', subcategoryId: null } }))
    // Identical to the item drawer's manual path (CategoryEditor → setOverride(itemNumber, { categoryId, subcategoryId: null })).
    const stored = ((await store.load()) as { overrides: Record<string, unknown> }).overrides
    expect(stored['101']).toEqual({ categoryId: 'electronics', subcategoryId: null })
    expect(categorize('101', ['ANKERSOLIX'], stored as never)).toMatchObject({ categoryId: 'electronics', source: 'override' })
    expect(screen.queryByTestId('suggestion-101')).not.toBeInTheDocument()
    expect(uncategorizedText()).not.toContain('ANKERSOLIX')
    expect(panel()).toHaveTextContent('1 accepted')
  })

  it('Change saves the edited category through the same override path', async () => {
    const { user, store } = await setup()
    await user.click(runButton())
    await user.click(within(await screen.findByTestId('suggestion-104')).getByRole('button', { name: /Change/ }))
    const form = within(row('104')).getByRole('form', { name: /Choose a category/ })
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Category' }), 'grocery')
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Subcategory' }), 'beverages')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(async () =>
      expect(((await store.load()) as { overrides: Record<string, unknown> }).overrides['104']).toEqual({ categoryId: 'grocery', subcategoryId: 'beverages' }),
    )
    expect(panel()).toHaveTextContent('1 changed')
  })

  it('Leave uncategorized writes nothing and leaves analytics unchanged', async () => {
    const { user, store } = await setup()
    await user.click(runButton())
    const before = uncategorizedText()
    await user.click(within(await screen.findByTestId('suggestion-102')).getByRole('button', { name: /Leave/ }))
    expect(screen.queryByTestId('suggestion-102')).not.toBeInTheDocument()
    expect(uncategorizedText()).toBe(before)
    expect(await store.load()).toEqual({ status: 'loaded', overrides: { '105': { categoryId: 'home', subcategoryId: null } } })
    expect(panel()).toHaveTextContent('1 left uncategorized')
  })

  it('accepts high-confidence suggestions only on an explicit bulk click, and filters uncertain ones', async () => {
    const { user, store } = await setup()
    await user.click(runButton())
    await screen.findByTestId('suggestion-101')
    // Nothing is accepted automatically, however confident.
    expect(((await store.load()) as { overrides: object }).overrides).not.toHaveProperty('101')
    await user.click(within(panel()).getByRole('radio', { name: 'Only uncertain 2' }))
    expect(screen.queryByTestId('suggestion-101')).not.toBeInTheDocument()
    expect(row('104')).toBeInTheDocument() // 60%
    expect(row('103')).toBeInTheDocument() // abstained
    await user.click(within(panel()).getByRole('radio', { name: /^All to review/ }))
    await user.click(within(panel()).getByRole('button', { name: 'Accept all high-confidence (2)' }))
    await waitFor(async () =>
      expect(((await store.load()) as { overrides: object }).overrides).toEqual({
        '101': { categoryId: 'electronics', subcategoryId: null },
        '102': { categoryId: 'alcohol', subcategoryId: null },
        '105': { categoryId: 'home', subcategoryId: null },
      }),
    )
    expect(row('104')).toBeInTheDocument() // below the threshold: still awaiting review
  })

  it('keeps successful batches when another batch fails, and retries only the failed items', async () => {
    const fn = suggester(async (items, call) => {
      if (call === 2) throw new Error('The AI model could not classify these items.')
      return { model: 'm', suggestions: items.map((i) => ({ itemNumber: i.itemNumber, categoryId: 'home' as const, subcategoryId: null, confidence: 0.5, reason: 'r' })) }
    })
    const { user } = await setup({ fn, extra: 30 }) // 34 Uncategorized → batches of 25 + 9
    await user.click(runButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('Some items could not be classified (9)')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn.mock.calls[0]![0]).toHaveLength(25)
    expect(within(screen.getByRole('region', { name: 'AI suggestions table' })).getAllByRole('row')).toHaveLength(26)
    const failedBatch = fn.mock.calls[1]![0].map((i) => i.itemNumber)
    await user.click(screen.getByRole('button', { name: 'Retry failed items (9)' }))
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(3))
    expect(fn.mock.calls[2]![0].map((i) => i.itemNumber)).toEqual(failedBatch)
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'AI suggestions table' })).getAllByRole('row')).toHaveLength(35))
  })

  it('never sends the same item twice in a review session, even on rapid clicks', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fn = suggester(async (items) => {
      await gate
      return { model: 'm', suggestions: items.map((i) => ({ itemNumber: i.itemNumber, categoryId: null, subcategoryId: null, confidence: 0, reason: '' })) }
    })
    const { user } = await setup({ fn })
    await user.click(runButton())
    expect(runButton()).toBeDisabled()
    expect(runButton()).toHaveTextContent('Suggesting…')
    await user.click(runButton()) // disabled: ignored
    release()
    await waitFor(() => expect(screen.getByTestId('ai-status')).toHaveTextContent('Every Uncategorized item has been sent in this session.'))
    expect(runButton()).toBeDisabled()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('caps each click at 100 items (4 requests) and continues on the next click', async () => {
    const fn = suggester()
    const { user } = await setup({ fn, extra: 120 })
    await user.click(runButton())
    await waitFor(() => expect(runButton()).not.toBeDisabled())
    expect(fn).toHaveBeenCalledTimes(4)
    expect(fn.mock.calls.flatMap((c) => c[0]).length).toBe(100)
    await user.click(runButton())
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(5))
    const all = fn.mock.calls.flatMap((c) => c[0].map((i) => i.itemNumber))
    expect(new Set(all).size).toBe(all.length) // no duplicates
    expect(all).toHaveLength(124)
  })

  it('local-file mode has no AI panel and stays fully usable', async () => {
    await setup({ local: true })
    expect(screen.queryByRole('region', { name: 'AI category suggestions' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Uncategorized items' })).toHaveTextContent('AI category suggestions are available when you use the cloud dashboard.')
  })

  it('manual overrides still beat rules, and rules still work (regression)', () => {
    const s = buildAnalyticsSnapshot(data(), { categoryOverrides: { '100': { categoryId: 'pet' } } })
    expect(s.items.byItemNumber.get('100')!.category).toMatchObject({ categoryId: 'pet', source: 'override' })
    expect(buildAnalyticsSnapshot(data()).items.byItemNumber.get('100')!.category).toMatchObject({ categoryId: 'paper-goods', source: 'rule' })
  })
})
