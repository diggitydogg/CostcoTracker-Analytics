import { useDashboard } from '../context'
import { change, count, money, share } from '../format'
import { CONFIDENCE_TEXT } from '../confidence'
import { ConfidenceBadge, DrillLink, Facts, Panel, TableWrap, td, tdNum, th, thNum } from '../ui'

/** The matched items behind one price-index link, so the figure can be reconciled item by item. */
export function InflationLinkDetail({ granularity, index }: { granularity: 'year' | 'month'; index: number }) {
  const { s, open } = useDashboard()
  const link = (granularity === 'year' ? s.inflation.yearly : s.inflation.monthly).links[index]
  if (!link) return <p className="text-sm text-slate-600">Not available.</p>
  const items = [...link.items].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || b.relative - a.relative)
  return (
    <>
      <Panel title="Summary">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <ConfidenceBadge confidence={link.confidence} />
          <span className="text-slate-600">{CONFIDENCE_TEXT[link.confidence].help}</span>
        </div>
        <Facts
          items={[
            ['Personal basket (weighted)', change(link.weightedChange)],
            ['Matched items (simple)', change(link.simpleChange)],
            ['Items compared', count(link.matchedItems)],
            ['Share of spend covered', share(link.spendCoverage)],
            ['Excluded as likely pack-size changes', count(link.outliersExcluded)],
          ]}
        />
      </Panel>
      <Panel title="Matched items" subtitle={`Average recorded unit price in ${link.from} and ${link.to}. Weight = share of matched spending.`}>
        {items.length === 0 ? (
          <p className="text-sm text-slate-600">No item was bought with a recorded price in both periods.</p>
        ) : (
          <TableWrap label="Matched items table">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className={th}>Item</th>
                  <th scope="col" className={thNum}>{link.from}</th>
                  <th scope="col" className={thNum}>{link.to}</th>
                  <th scope="col" className={thNum}>Change</th>
                  <th scope="col" className={thNum}>Weight</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.itemNumber} className="border-b border-slate-100 last:border-0">
                    <td className={td}>
                      <DrillLink onClick={() => open({ kind: 'item', itemNumber: i.itemNumber })}>
                        {s.items.byItemNumber.get(i.itemNumber)?.displayDescription ?? `Item ${i.itemNumber}`}
                      </DrillLink>
                    </td>
                    <td className={tdNum}>{money(Math.round(i.fromPriceCents))}</td>
                    <td className={tdNum}>{money(Math.round(i.toPriceCents))}</td>
                    <td className={tdNum}>{change(i.relative - 1)}</td>
                    <td className={tdNum}>{i.weight === null ? '—' : share(i.weight)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>
    </>
  )
}
