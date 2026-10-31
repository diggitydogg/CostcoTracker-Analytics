import { useMemo, useState } from 'react'
import type { LoadedDataset } from '../domain/dataset'
import { summarizeImport } from '../domain/summary'

type View = 'summary' | 'details'

const VIEWS: { id: View; label: string }[] = [
  { id: 'summary', label: 'Import summary' },
  { id: 'details', label: 'Import details' },
]

/**
 * Minimal shell proving that an import succeeded. Analytics dashboards are
 * intentionally out of scope for this task; navigation will grow later.
 */
export function DatasetShell({ dataset, onImportAnother }: { dataset: LoadedDataset; onImportAnother: () => void }) {
  const [view, setView] = useState<View>('summary')
  const summary = useMemo(() => summarizeImport(dataset.data), [dataset.data])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Dataset sections" className="flex flex-wrap gap-1 rounded-lg bg-slate-200 p-1">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-current={view === v.id ? 'page' : undefined}
              onClick={() => setView(v.id)}
              className={
                'rounded-md px-3 py-1.5 text-sm font-medium ' +
                (view === v.id ? 'bg-white shadow-sm' : 'text-slate-700 hover:bg-slate-100')
              }
            >
              {v.label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={onImportAnother}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Import a different file
        </button>
      </div>

      {dataset.meta.isSyntheticDemo && (
        <p className="rounded-md border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          You are viewing synthetic demo data. It is not real purchase history.
        </p>
      )}

      {view === 'summary' ? (
        <section aria-labelledby="summary-title" className="space-y-4">
          <h2 id="summary-title" className="text-xl font-semibold">
            Imported records
          </h2>
          <dl className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-4">
            <Stat label="Receipts / orders" value={summary.receiptCount} />
            <Stat label="Items" value={summary.itemCount} />
            <Stat label="Returns" value={summary.returnCount} />
            <Stat label="Price adjustments" value={summary.priceAdjustmentCount} />
          </dl>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Receipts by source type</caption>
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Source type</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Receipts / orders</th>
                </tr>
              </thead>
              <tbody>
                {(['warehouse', 'online', 'synthetic'] as const).map((source) => (
                  <tr key={source} className="border-t border-slate-100">
                    <td className="px-4 py-2 capitalize">{source}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{summary.receiptCountBySource[source]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-slate-700">
            {summary.purchaseDateRange
              ? `Purchase dates range from ${summary.purchaseDateRange.first} to ${summary.purchaseDateRange.last}.`
              : 'No receipt in this file has a purchase date.'}
            {summary.receiptsWithoutDate > 0 &&
              ` ${summary.receiptsWithoutDate} ${summary.receiptsWithoutDate === 1 ? 'receipt has' : 'receipts have'} no purchase date.`}
          </p>
        </section>
      ) : (
        <section aria-labelledby="details-title" className="space-y-4">
          <h2 id="details-title" className="text-xl font-semibold">
            Import details
          </h2>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium text-slate-600">Source</dt>
            <dd className="break-all">{dataset.meta.sourceLabel}</dd>
            <dt className="font-medium text-slate-600">Format version</dt>
            <dd>{dataset.data.formatVersion}</dd>
            <dt className="font-medium text-slate-600">Exported at</dt>
            <dd>{dataset.data.exportedAt}</dd>
            <dt className="font-medium text-slate-600">Currency</dt>
            <dd>{dataset.data.currency}</dd>
            <dt className="font-medium text-slate-600">Imported into this browser</dt>
            <dd>{dataset.meta.importedAt}</dd>
          </dl>
          <h3 className="text-base font-semibold">Ignored fields</h3>
          {dataset.warnings.length === 0 ? (
            <p className="text-sm text-slate-700">Every field in the file was recognized.</p>
          ) : (
            <ul className="space-y-1 text-sm text-slate-700" data-testid="import-warnings">
              {dataset.warnings.map((w) => (
                <li key={w.location}>
                  <span className="font-medium">{w.location}</span>: {w.fields.join(', ')} ({w.recordCount}{' '}
                  {w.recordCount === 1 ? 'record' : 'records'}). These fields are not part of format version{' '}
                  {dataset.data.formatVersion} and were not imported.
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</dd>
    </div>
  )
}
