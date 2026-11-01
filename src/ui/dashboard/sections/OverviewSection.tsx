import { useMemo, useState } from 'react'
import { ratio } from '../../../analytics/stats'
import { ColumnChart } from '../charts/ColumnChart'
import { SERIES } from '../charts/palette'
import { useDashboard } from '../context'
import { changeVs, periods, type PeriodId } from '../derive'
import { change, count, date, days, money, moneyAxis, moneyWhole, month, monthShort, share } from '../format'
import { DataQualityPanel } from './DataQualityPanel'
import type { DashboardTab } from '../Dashboard'
import { BarList, DrillLink, Facts, Panel, Segmented, StatCard, TableWrap, td, tdNum, th, thNum } from '../ui'

type Range = '12' | '24' | 'all'

export function OverviewSection({ onShowTab }: { onShowTab: (t: DashboardTab) => void }) {
  const { s, open, lookups } = useDashboard()
  const options = useMemo(() => periods(s), [s])
  const [periodId, setPeriodId] = useState<PeriodId>('all')
  const period = options.find((p) => p.id === periodId) ?? options[0]!
  const t = period.totals
  const prev = period.previous
  const vs = (cur: number | null, p: number | null | undefined) => {
    if (period.id === 'all') return null
    if (!prev) return <span className="text-slate-500">No comparable earlier period in the data</span>
    return (
      <span>
        <span className="font-medium text-slate-800">{change(changeVs(cur, p))}</span> vs {prev.label}
      </span>
    )
  }
  const L = s.spending.lifetime

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Time period" value={period.id} options={options.map((o) => ({ id: o.id, label: o.label }))} onChange={setPeriodId} />
        <p className="text-xs text-slate-500">
          {period.range ? `${month(period.range.start)} – ${month(period.range.end)}` : 'Everything in the data, including undated records'}
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6" aria-label="Summary">
        <StatCard
          label="Net Costco spend"
          value={moneyWhole(t.netCents)}
          hint="Gross purchases minus recorded returns and price adjustments. Pre-tax."
          detail={vs(t.netCents, prev?.totals.netCents) ?? 'Gross − returns − price adjustments'}
        />
        <StatCard
          label="Gross purchases"
          value={moneyWhole(t.grossCents)}
          hint="Sum of exported item line totals, after instant savings and before tax."
          detail={vs(t.grossCents, prev?.totals.grossCents) ?? `${money(s.spending.averageMonthlyGrossCents)} per month on average`}
        />
        <StatCard
          label="Returns"
          value={moneyWhole(t.refundCents)}
          hint="Recorded returned merchandise value. Returns are not linked to the purchase they came from."
          detail={`${share(period.id === 'all' ? s.returns.observedReturnValueRatio : t.grossCents > 0 ? ratio(t.refundCents, t.grossCents) : null)} of observed spend`}
        />
        <StatCard
          label="Price adjustments recovered"
          value={moneyWhole(t.adjustmentCents)}
          hint="Recorded price-adjustment refunds. They are not linked to a specific purchase."
          detail={`${share(period.id === 'all' ? s.adjustments.observedAdjustmentValueRatio : t.grossCents > 0 ? ratio(t.adjustmentCents, t.grossCents) : null)} of observed spend`}
        />
        <StatCard
          label="Purchases"
          value={count(t.events)}
          hint="Warehouse receipts and online orders."
          detail={vs(t.events, prev?.totals.events) ?? `${count(s.trips.bySource.warehouse)} warehouse · ${count(s.trips.bySource.online)} online`}
        />
        <StatCard
          label="Average basket"
          value={money(t.averageBasketCents)}
          hint="Estimated from exported item line totals; pre-tax. Purchases without exported lines are left out."
          detail={vs(t.averageBasketCents, prev?.totals.averageBasketCents) ?? `Median ${money(s.trips.basket.medianCents)}`}
        />
      </dl>

      <SpendingChartPanel />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <Panel title="Shopping trips" subtitle="Baskets are estimated from exported item lines and are pre-tax.">
          <Facts
            items={[
              ['Purchases', count(s.trips.eventCount)],
              ['Shopping days', count(s.trips.intervals.shoppingDays)],
              ['Average basket', money(s.trips.basket.averageCents)],
              ['Median basket', money(s.trips.basket.medianCents)],
              ['Typical gap between trips', days(s.trips.intervals.medianDays)],
              ['Average gap', days(s.trips.intervals.averageDays)],
              [
                'Longest gap',
                s.trips.intervals.longestGap ? `${days(s.trips.intervals.longestGap.days)} (${date(s.trips.intervals.longestGap.from)})` : '—',
              ],
              [
                'Busiest month',
                s.trips.busiestMonths.length === 0
                  ? '—'
                  : s.trips.busiestMonths.length <= 2
                    ? s.trips.busiestMonths.map((m) => month(m)).join(', ')
                    : `${s.trips.busiestMonths.length} months tied`,
              ],
              ['Most purchases in one month', count(Math.max(0, ...s.trips.byMonth.map((m) => m.count)))],
              ['Busiest weekday', s.trips.busiestWeekdays.join(', ') || '—'],
              ['Items per purchase', count(s.trips.linesPerEvent.average === null ? null : Math.round(s.trips.linesPerEvent.average * 10) / 10)],
            ]}
            columns={1}
          />
        </Panel>

        <Panel title="Largest purchases" subtitle="Select one to see its item lines.">
          {s.trips.basket.largest.length === 0 ? (
            <p className="text-sm text-slate-600">No purchases with item lines yet.</p>
          ) : (
            <TableWrap label="Largest purchases table">
              <table className="w-full min-w-[22rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th scope="col" className={th}>Date</th>
                    <th scope="col" className={th}>Where</th>
                    <th scope="col" className={thNum}>Items</th>
                    <th scope="col" className={thNum}>Basket</th>
                  </tr>
                </thead>
                <tbody>
                  {s.trips.basket.largest.map((e) => (
                    <tr key={e.id} className="border-b border-slate-100 last:border-0">
                      <td className={td}>
                        <DrillLink onClick={() => open({ kind: 'receipt', id: e.id })} label={`Open purchase on ${date(e.date)}`}>
                          {date(e.date)}
                        </DrillLink>
                      </td>
                      <td className={`${td} max-w-[12rem] truncate text-slate-700`}>{lookups.warehouseLabelByReceipt.get(e.id) ?? '—'}</td>
                      <td className={tdNum}>{count(e.lineCount)}</td>
                      <td className={`${tdNum} font-medium`}>{money(e.basketCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Panel>

        <Panel
          title="Warehouse vs online"
          actions={
            <button type="button" className="text-xs font-medium text-sky-800 hover:underline" onClick={() => onShowTab('warehouses')}>
              All warehouses →
            </button>
          }
        >
          <BarList
            label="Spend by channel"
            rows={(['warehouse', 'online', 'synthetic'] as const)
              .filter((c) => s.warehouses.channels[c].events > 0)
              .map((c) => {
                const ch = s.warehouses.channels[c]
                return {
                  key: c,
                  label: c === 'warehouse' ? 'In warehouse' : c === 'online' ? 'Online orders' : 'Synthetic (test) data',
                  value: moneyWhole(ch.spendCents),
                  fraction: ch.spendShare,
                  detail: `${count(ch.events)} purchases · average ${money(ch.averageBasketCents)}`,
                }
              })}
          />
          {L.returnsWithoutAmount.count > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              {count(L.returnsWithoutAmount.count)} return(s) have no recorded amount and are not in the return totals.
            </p>
          )}
        </Panel>

        <DataQualityPanel className="2xl:col-span-3" />
      </div>
    </div>
  )
}

function SpendingChartPanel() {
  const { s, open } = useDashboard()
  const [range, setRange] = useState<Range>(s.spending.monthly.length > 24 ? '24' : 'all')
  const [showNet, setShowNet] = useState(true)
  const all = s.spending.monthly
  const months = range === 'all' ? all : all.slice(-Number(range))
  const multiYear = new Set(months.map((m) => m.month.slice(0, 4))).size > 1
  const undated = s.spending.undated
  const hasUndated = undated.grossCents + undated.refundCents + undated.adjustmentCents > 0

  return (
    <Panel
      title="Monthly spending"
      subtitle="Purchases above the line; returns and price adjustments below it. Months with no activity show as zero."
      actions={
        <>
          <label className="flex items-center gap-1.5 text-xs text-slate-700">
            <input type="checkbox" checked={showNet} onChange={(e) => setShowNet(e.target.checked)} className="h-3.5 w-3.5 accent-slate-800" />
            Net spend line
          </label>
          <Segmented
            label="Chart range"
            value={range}
            onChange={setRange}
            options={[
              { id: '12', label: '12 months' },
              { id: '24', label: '24 months' },
              { id: 'all', label: 'All time' },
            ]}
          />
        </>
      }
    >
      <ColumnChart
        key={`${range}-${months.length}`}
        title="Monthly spending chart"
        labels={months.map((m) => month(m.month))}
        axisLabels={months.map((m) => monthShort(m.month, multiYear))}
        series={[
          { key: 'gross', label: 'Purchases', color: SERIES.blue, values: months.map((m) => m.grossCents) },
          { key: 'returns', label: 'Returns', color: SERIES.orange, values: months.map((m) => m.refundCents), direction: 'down' },
          { key: 'adj', label: 'Price adjustments', color: SERIES.aqua, values: months.map((m) => m.adjustmentCents), direction: 'down' },
        ]}
        line={showNet ? { key: 'net', label: 'Net spend', color: SERIES.ink, values: months.map((m) => m.netCents) } : null}
        formatValue={money}
        formatAxis={moneyAxis}
        openLabel={(i) => `Records for ${month(months[i]!.month)}`}
        onOpen={(i) => {
          const m = months[i]!
          open({
            kind: 'records',
            title: month(m.month),
            description: `Purchases ${money(m.grossCents)} · returns ${money(m.refundCents)} · adjustments ${money(m.adjustmentCents)} · net ${money(m.netCents)}`,
            receiptIds: m.receiptIds,
            returnIds: m.returnIds,
            adjustmentIds: m.adjustmentIds,
          })
        }}
      />
      {hasUndated && (
        <p className="mt-2 text-xs text-slate-500">
          Not shown (no date): purchases {money(undated.grossCents)}, returns {money(undated.refundCents)}, adjustments {money(undated.adjustmentCents)}. They are
          included in all-time totals.{' '}
          <DrillLink
            onClick={() =>
              open({ kind: 'records', title: 'Undated records', receiptIds: undated.receiptIds, returnIds: undated.returnIds, adjustmentIds: undated.adjustmentIds })
            }
          >
            View
          </DrillLink>
        </p>
      )}
    </Panel>
  )
}
