import type { Drill } from '../context'
import { useDashboard } from '../context'
import { count, date, money } from '../format'
import { DrillLink, Panel, TableWrap, td, tdNum, th, thNum } from '../ui'
import { warehouseText } from './text'

/** The underlying records of an aggregate (a month, a warehouse, a category…), from the IDs the engine attached to it. */
export function RecordsDetail({ drill }: { drill: Extract<Drill, { kind: 'records' }> }) {
  const { s, open, lookups } = useDashboard()
  const receipts = (drill.receiptIds ?? [])
    .map((id) => s.index.eventsById.get(id)!)
    .filter(Boolean)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (a.id < b.id ? -1 : 1))
  const returns = (drill.returnIds ?? []).map((id) => lookups.returnById.get(id)!).filter(Boolean)
  const adjustments = (drill.adjustmentIds ?? []).map((id) => lookups.adjustmentById.get(id)!).filter(Boolean)
  const itemName = (n: string, fallback?: string | null) => s.items.byItemNumber.get(n)?.displayDescription ?? fallback ?? `Item ${n}`

  return (
    <>
      {drill.description && <p className="text-sm text-slate-700">{drill.description}</p>}
      {drill.receiptIds && (
        <Panel title={`Purchases (${count(receipts.length)})`}>
          {receipts.length === 0 ? (
            <p className="text-sm text-slate-600">None.</p>
          ) : (
            <TableWrap label="Purchases table">
              <table className="w-full min-w-[26rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th scope="col" className={th}>Date</th>
                    <th scope="col" className={th}>Where</th>
                    <th scope="col" className={thNum}>Items</th>
                    <th scope="col" className={thNum}>Basket</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((e) => (
                    <tr key={e.id} className="border-b border-slate-100 last:border-0">
                      <td className={td}>
                        <DrillLink onClick={() => open({ kind: 'receipt', id: e.id })}>{date(e.date)}</DrillLink>
                      </td>
                      <td className={`${td} max-w-[14rem] truncate text-slate-700`}>{lookups.warehouseLabelByReceipt.get(e.id) ?? '—'}</td>
                      <td className={tdNum}>{count(e.lineCount)}</td>
                      <td className={tdNum}>{money(e.basketCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Panel>
      )}
      {drill.returnIds && (
        <Panel title={`Returns (${count(returns.length)})`} subtitle="Not linked to the purchase they came from.">
          {returns.length === 0 ? (
            <p className="text-sm text-slate-600">None.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {returns.map((r) => (
                <li key={r.id} className="flex justify-between gap-3 border-b border-slate-100 pb-1.5">
                  <span className="min-w-0">
                    <DrillLink onClick={() => open({ kind: 'item', itemNumber: r.itemNumber })}>{itemName(r.itemNumber, r.description)}</DrillLink>
                    <span className="block text-xs text-slate-500">
                      {date(r.returnDate)} · qty {count(r.quantity)} · {warehouseText(r.warehouse)}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{r.merchandiseAmountCents === null ? <span className="text-slate-500">not recorded</span> : money(r.merchandiseAmountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {drill.adjustmentIds && (
        <Panel title={`Price adjustments (${count(adjustments.length)})`}>
          {adjustments.length === 0 ? (
            <p className="text-sm text-slate-600">None.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {adjustments.map((a) => (
                <li key={a.id} className="flex justify-between gap-3 border-b border-slate-100 pb-1.5">
                  <span className="min-w-0">
                    <DrillLink onClick={() => open({ kind: 'item', itemNumber: a.itemNumber })}>{itemName(a.itemNumber)}</DrillLink>
                    <span className="block text-xs text-slate-500">{date(a.adjustmentDate)}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{money(a.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </>
  )
}
