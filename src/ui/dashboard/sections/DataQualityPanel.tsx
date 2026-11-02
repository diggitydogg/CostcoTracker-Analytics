import type { ReactNode } from 'react'
import { useDashboard } from '../context'
import { count, share } from '../format'
import { ConfidenceBadge, Panel } from '../ui'

/** "About these numbers": the few limitations that matter for this dataset, in plain language. */
export function DataQualityPanel({ className = '' }: { className?: string }) {
  const { s, overrides } = useDashboard()
  const q = s.quality
  const notes: { key: string; label: string; body: ReactNode }[] = [
    { key: 'tax', label: 'Spend', body: 'Pre-tax merchandise from exported item lines (after instant savings). The export has no tax or receipt totals.' },
    {
      key: 'prices',
      label: 'Unit prices',
      body:
        q.itemLinesWithoutUnitPrice.count === 0
          ? 'Every item line has a recorded unit price.'
          : `${count(q.itemLinesWithoutUnitPrice.count)} item lines (${share(q.itemLinesWithoutUnitPrice.spendShare)} of spend) have no recorded unit price, so they are not used for price history or the price index. Prices are never estimated.`,
    },
    {
      key: 'categories',
      label: 'Categories',
      body: `${share(q.uncategorized.spendShare)} of spend is Uncategorized (${count(q.uncategorized.itemCount)} items). Categories come from description rules${
        s.categories.bySource.override > 0 ? ` and ${count(s.categories.bySource.override)} of your manual choices` : ''
      }.${overrides.persistent ? '' : ' Manual choices apply to this tab only in this browser.'}`,
    },
    {
      key: 'index',
      label: 'Price index',
      body: (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <ConfidenceBadge confidence={q.inflation.latestYearConfidence} />
          <span>
            {count(q.inflation.eligibleItems)} items have recorded prices in at least two years. Confidence depends on how much of your spending repeat items cover.
          </span>
        </span>
      ),
    },
    {
      key: 'linkage',
      label: 'Returns & adjustments',
      body:
        s.returns.purchaseLinkedReturnRate.available && s.adjustments.purchaseLinkedSavingsRate.available
          ? 'Returns and adjustments are linked to the purchases they came from.'
          : 'Not linked to the purchase they came from, so they are shown as a share of observed spend, not as return or savings rates. Some may relate to purchases from before this data begins.',
    },
  ]
  if (q.receiptsBySource.synthetic > 0)
    notes.push({ key: 'synthetic', label: 'Synthetic data', body: `${count(q.receiptsBySource.synthetic)} synthetic (test/demo) receipts are included.` })
  if (q.receiptsWithoutDate.count > 0)
    notes.push({ key: 'undated', label: 'Undated', body: `${count(q.receiptsWithoutDate.count)} receipts have no date; they count in all-time totals only.` })
  if (q.synthesizedWarehouseKeyReceipts > 0)
    notes.push({
      key: 'whse',
      label: 'Trip counts',
      body: `${count(q.synthesizedWarehouseKeyReceipts)} receipts had no barcode; same-day trips to one warehouse may be combined, so trip counts are a minimum.`,
    })
  if (q.source?.excludedTombstonedRecords)
    notes.push({
      key: 'tomb',
      label: 'Removed on iPhone',
      body: `${count(q.source.excludedTombstonedRecords)} cloud records no longer on the iPhone are kept as history but not included.`,
    })

  return (
    <Panel title="About these numbers" className={className}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm @regular:grid-cols-2 @panoramic:grid-cols-3">
        {notes.map((n) => (
          <div key={n.key} className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{n.label}</dt>
            <dd className="mt-0.5 text-slate-700">{n.body}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-sky-800">All data notes ({q.limitations.length})</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700" aria-label="Data notes">
          {q.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
    </Panel>
  )
}
