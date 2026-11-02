import { useDeferredValue, useMemo, useState } from 'react'
import { CATEGORIES, categoryLabel } from '../../../analytics'
import { useDashboard } from '../context'
import { COHORT_LABEL, itemsSummary, queryItems, type ItemFilter, type ItemSortKey } from '../derive'
import { change, count, date, money } from '../format'
import { Badge, Panel, Segmented, TableWrap } from '../ui'

const FILTERS: { id: ItemFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'staple', label: 'Staples' },
  { id: 'occasional', label: 'Occasional' },
  { id: 'one-and-done', label: 'One-and-done' },
  { id: 'dormant-staple', label: 'Dormant staples' },
  { id: 'recent', label: 'Recent' },
  // Item numbers seen only in returns or price adjustments (bought before the data begins).
  { id: 'not-purchased', label: 'Returns/adjustments only' },
]

const COLUMNS: { key: ItemSortKey; label: string; numeric?: boolean; defaultDescending?: boolean }[] = [
  { key: 'description', label: 'Item' },
  { key: 'spend', label: 'Total spend', numeric: true, defaultDescending: true },
  { key: 'quantity', label: 'Quantity', numeric: true, defaultDescending: true },
  { key: 'events', label: 'Purchases', numeric: true, defaultDescending: true },
  { key: 'lastPurchase', label: 'Last purchase', defaultDescending: true },
  { key: 'latestPrice', label: 'Latest price', numeric: true, defaultDescending: true },
  { key: 'priceChange', label: 'First → latest', numeric: true, defaultDescending: true },
  { key: 'cohort', label: 'Pattern' },
]

const PAGE = 50


export function ItemsSection() {
  const { s, open, selected } = useDashboard()
  const selectedItem = selected?.kind === 'item' ? selected.itemNumber : null
  const [search, setSearch] = useState('')
  const deferred = useDeferredValue(search)
  const [filter, setFilter] = useState<ItemFilter>('all')
  const [categoryId, setCategoryId] = useState<string>('all')
  const [sort, setSort] = useState<ItemSortKey>('spend')
  const [descending, setDescending] = useState(true)
  const [limit, setLimit] = useState(PAGE)

  const rows = useMemo(
    () => queryItems(s.items.items, { search: deferred, filter, categoryId, sort, descending }),
    [s.items.items, deferred, filter, categoryId, sort, descending],
  )
  const counts = useMemo(() => {
    const c: Record<ItemFilter, number> = { all: s.items.itemCounts.all, recent: s.items.cohorts.recent.length } as Record<ItemFilter, number>
    for (const f of ['staple', 'occasional', 'one-and-done', 'dormant-staple', 'not-purchased'] as const) c[f] = s.items.cohorts[f].length
    return c
  }, [s])
  const usedCategories = useMemo(() => new Set(s.items.items.map((i) => i.category.categoryId)), [s])

  const sortBy = (key: ItemSortKey) => {
    const col = COLUMNS.find((c) => c.key === key)!
    if (key === sort) setDescending((d) => !d)
    else {
      setSort(key)
      setDescending(col.defaultDescending ?? false)
    }
  }

  return (
    <Panel
      title="Item explorer"
      subtitle={`${itemsSummary(s.items.itemCounts)} Recent = bought in the last ${s.thresholds.recentDays} days of the data. Prices are recorded unit prices only.`}
    >
      <div className="mb-3 flex flex-col gap-2 @wide:flex-row @wide:items-center @wide:justify-between">
        <div className="flex flex-1 flex-col gap-2 @regular:flex-row">
          <label className="min-w-0 flex-1 @regular:max-w-sm">
            <span className="sr-only">Search items</span>
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setLimit(PAGE)
              }}
              placeholder="Search description or item number"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm placeholder:text-slate-400"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <span className="shrink-0 text-xs text-slate-500">Category</span>
            <select
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value)
                setLimit(PAGE)
              }}
              className="min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="all">All categories</option>
              {CATEGORIES.filter((c) => usedCategories.has(c.id)).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Segmented
          label="Purchase pattern"
          value={filter}
          onChange={(f) => {
            setFilter(f)
            setLimit(PAGE)
          }}
          options={FILTERS.filter((f) => f.id !== 'not-purchased' || counts[f.id] > 0).map((f) => ({ id: f.id, label: `${f.label} ${count(counts[f.id])}` }))}
        />
      </div>

      <p className="mb-2 text-xs text-slate-500" aria-live="polite" data-testid="item-count">
        {rows.length === 1 ? '1 item' : `${count(rows.length)} items`}
      </p>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-600">No items match.</p>
      ) : (
        <TableWrap label="Items table">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-200">
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={sort === c.key ? (descending ? 'descending' : 'ascending') : 'none'}
                    className={`whitespace-nowrap px-2 py-2 text-xs font-medium text-slate-500 ${c.numeric ? 'text-right' : 'text-left'}`}
                  >
                    <button type="button" onClick={() => sortBy(c.key)} className="inline-flex items-center gap-1 hover:text-slate-900">
                      {c.label}
                      <span aria-hidden className="text-[0.625rem]">
                        {sort === c.key ? (descending ? '▼' : '▲') : ''}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((i) => (
                <tr
                  key={i.itemNumber}
                  // Apple (split views): persistently highlight the selection that leads to the detail.
                  aria-current={selectedItem === i.itemNumber ? 'true' : undefined}
                  className={`border-b border-slate-100 ${selectedItem === i.itemNumber ? 'bg-sky-50' : 'hover:bg-slate-50'}`}
                >
                  <td className="max-w-[22rem] px-2 py-2">
                    <button type="button" onClick={() => open({ kind: 'item', itemNumber: i.itemNumber })} className="block max-w-full text-left">
                      <span className="block truncate font-medium text-sky-900 hover:underline" title={i.displayDescription}>
                        {i.displayDescription}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                        #{i.itemNumber}
                        <span aria-hidden>·</span>
                        {categoryLabel(i.category.categoryId)}
                        {i.category.source === 'override' && <Badge tone="violet">Manual</Badge>}
                      </span>
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums">{money(i.totalSpentCents)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{count(i.totalQuantity)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{count(i.purchaseEvents)}</td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums">{date(i.lastPurchaseDate)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{money(i.latestUnitPriceCents)}</td>
                  <td className={`whitespace-nowrap px-2 py-2 text-right tabular-nums ${(i.priceChange ?? 0) > 0 ? 'text-red-800' : (i.priceChange ?? 0) < 0 ? 'text-emerald-800' : ''}`}>
                    {change(i.priceChange)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">
                    <span className="text-slate-700">{COHORT_LABEL[i.cohort]}</span>
                    {i.recent && (
                      <span className="ml-1.5">
                        <Badge tone="sky" title="Bought in the last days of the data">
                          Recent
                        </Badge>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {rows.length > limit && (
        <div className="mt-3 text-center">
          <button type="button" onClick={() => setLimit((l) => l + PAGE * 2)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
            Show more ({count(rows.length - limit)} remaining)
          </button>
        </div>
      )}
    </Panel>
  )
}
