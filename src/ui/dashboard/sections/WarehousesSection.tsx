import type { WarehouseGroup } from '../../../analytics'
import { useDashboard } from '../context'
import { count, date, money, moneyWhole, share } from '../format'
import { Badge, BarList, DrillLink, Panel, StatCard, TableWrap, td, tdNum, th, thNum } from '../ui'

const KIND: Record<WarehouseGroup['kind'], { label: string; tone: 'slate' | 'sky' | 'amber' | 'violet' } | null> = {
  store: null,
  'online-fulfillment': { label: 'Online', tone: 'sky' },
  placeholder: { label: 'Name not recorded', tone: 'amber' },
  unknown: { label: 'No warehouse', tone: 'amber' },
  synthetic: { label: 'Synthetic', tone: 'violet' },
}

/** Warehouses exactly as the engine groups them: only case/spacing variants are merged; nothing is merged by guess. */
export function WarehousesSection() {
  const { s, open } = useDashboard()
  const w = s.warehouses
  const total = w.groups.reduce((t, g) => t + g.spendCents, 0)

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-3 @pair:grid-cols-2 @spacious:grid-cols-4">
        <StatCard label="In warehouse" value={moneyWhole(w.channels.warehouse.spendCents)} detail={`${count(w.channels.warehouse.events)} purchases · ${share(w.channels.warehouse.spendShare)} of spend`} />
        <StatCard label="Online orders" value={moneyWhole(w.channels.online.spendCents)} detail={`${count(w.channels.online.events)} orders · ${share(w.channels.online.spendShare)} of spend`} />
        <StatCard label="Average warehouse basket" value={money(w.channels.warehouse.averageBasketCents)} />
        <StatCard label="Average online order" value={money(w.channels.online.averageBasketCents)} />
      </dl>

      <div className="grid grid-cols-1 gap-4 @spacious:grid-cols-5">
        <Panel title="Spend by location" subtitle="Share of gross purchases." className="@spacious:col-span-2">
          <BarList
            label="Spend by location"
            rows={w.groups.slice(0, 12).map((g) => ({
              key: g.key,
              label: g.label,
              value: moneyWhole(g.spendCents),
              fraction: total > 0 ? g.spendCents / total : null,
              onClick: () => open({ kind: 'records', title: g.label, description: `${count(g.events)} purchases · ${money(g.spendCents)}`, receiptIds: g.receiptIds }),
              accessibleLabel: `${g.label}: ${moneyWhole(g.spendCents)}. Show purchases.`,
            }))}
          />
        </Panel>

        <Panel title="All locations" subtitle="Select a location to see its purchases. Different spellings are only merged when they differ by case or spacing." className="@spacious:col-span-3">
          <TableWrap label="Locations table">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className={th}>Location</th>
                  <th scope="col" className={thNum}>Purchases</th>
                  <th scope="col" className={thNum}>Spend</th>
                  <th scope="col" className={thNum}>Avg basket</th>
                  <th scope="col" className={thNum}>Items</th>
                  <th scope="col" className={th}>Last visit</th>
                </tr>
              </thead>
              <tbody>
                {w.groups.map((g) => (
                  <tr key={g.key} className="border-b border-slate-100 last:border-0">
                    <td className={td}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <DrillLink onClick={() => open({ kind: 'records', title: g.label, receiptIds: g.receiptIds })}>{g.label}</DrillLink>
                        {KIND[g.kind] && <Badge tone={KIND[g.kind]!.tone}>{KIND[g.kind]!.label}</Badge>}
                      </span>
                      {g.variants.length > 1 && <span className="block text-xs text-slate-500">Recorded as: {g.variants.join(' · ')}</span>}
                    </td>
                    <td className={tdNum}>{count(g.events)}</td>
                    <td className={tdNum}>{money(g.spendCents)}</td>
                    <td className={tdNum}>{money(g.averageBasketCents)}</td>
                    <td className={tdNum}>{count(g.uniqueItems)}</td>
                    <td className={`${td} whitespace-nowrap`}>{date(g.lastDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Panel>
      </div>
    </div>
  )
}
