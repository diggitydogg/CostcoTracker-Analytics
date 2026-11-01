import { categoryLabel } from '../../../analytics'
import { useDashboard } from '../context'
import { count, date, money } from '../format'
import { DrillLink, Facts, Panel, TableWrap, td, tdNum, th, thNum } from '../ui'

/** One purchase event and its exported item lines. Opaque IDs only; no barcode or order number exists in the data. */
export function ReceiptDetail({ id }: { id: string }) {
  const { s, open, lookups } = useDashboard()
  const e = s.index.eventsById.get(id)
  if (!e) return <p className="text-sm text-slate-600">This purchase is not in the current data.</p>
  const lines = e.lineIds.map((l) => lookups.lineById.get(l)!)
  return (
    <>
      <Panel title="Summary">
        <Facts
          items={[
            ['Date', date(e.date)],
            ['Channel', e.sourceType === 'online' ? 'Online order' : e.sourceType === 'synthetic' ? 'Synthetic (test) data' : 'In warehouse'],
            ['Where', lookups.warehouseLabelByReceipt.get(e.id) ?? '—'],
            ['Item lines', count(e.lineCount)],
            ['Units', count(e.units)],
            ['Estimated basket (pre-tax)', money(e.basketCents)],
          ]}
        />
        {e.identifierKind === 'synthesizedWarehouseKey' && (
          <p className="mt-2 text-xs text-slate-500">This receipt had no barcode, so it may combine more than one trip on the same day.</p>
        )}
      </Panel>
      <Panel title="Items" subtitle="Line totals are after instant savings.">
        {lines.length === 0 ? (
          <p className="text-sm text-slate-600">No item lines were exported for this purchase.</p>
        ) : (
          <TableWrap label="Purchase items table">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className={th}>Item</th>
                  <th scope="col" className={thNum}>Qty</th>
                  <th scope="col" className={thNum}>Unit price</th>
                  <th scope="col" className={thNum}>Line total</th>
                </tr>
              </thead>
              <tbody>
                {[...lines]
                  .sort((a, b) => b.lineTotalCents - a.lineTotalCents || (a.id < b.id ? -1 : 1))
                  .map((l) => {
                    const item = s.items.byItemNumber.get(l.itemNumber)
                    return (
                      <tr key={l.id} className="border-b border-slate-100 last:border-0">
                        <td className={td}>
                          <DrillLink onClick={() => open({ kind: 'item', itemNumber: l.itemNumber })}>{item?.displayDescription ?? l.description}</DrillLink>
                          <span className="block text-xs text-slate-500">
                            #{l.itemNumber}
                            {item ? ` · ${categoryLabel(item.category.categoryId)}` : ''}
                          </span>
                        </td>
                        <td className={tdNum}>{count(l.quantity)}</td>
                        <td className={tdNum}>{l.unitPriceCents === null ? <span className="text-slate-500">not recorded</span> : money(l.unitPriceCents)}</td>
                        <td className={tdNum}>{money(l.lineTotalCents)}</td>
                      </tr>
                    )
                  })}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 font-medium">
                  <td className={td} colSpan={3}>
                    Total of exported lines
                  </td>
                  <td className={tdNum}>{money(e.basketCents)}</td>
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}
      </Panel>
    </>
  )
}
