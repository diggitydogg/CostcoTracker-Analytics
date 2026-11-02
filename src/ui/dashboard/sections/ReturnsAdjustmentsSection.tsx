import { useMemo, useState } from 'react'
import { ColumnChart } from '../charts/ColumnChart'
import { SERIES } from '../charts/palette'
import { useDashboard } from '../context'
import { count, date, money, moneyAxis, month, monthShort, share } from '../format'
import { Badge, DrillLink, Panel, Segmented, StatCard, TableWrap, td, tdNum, th, thNum } from '../ui'

/**
 * Returns and price adjustments. They are not linked to the purchases they
 * came from (sourcePurchaseId is empty), so ratios are labelled as shares of
 * observed spend, never as return or savings rates.
 */
export function ReturnsAdjustmentsSection() {
  return (
    <div className="grid grid-cols-1 gap-4 @panoramic:grid-cols-2">
      <ReturnsPanel />
      <AdjustmentsPanel />
    </div>
  )
}

function useMonthWindow() {
  const { s } = useDashboard()
  // Returns and adjustments are sparse; show their whole history by default.
  const [range, setRange] = useState<'24' | 'all'>('all')
  const months = range === 'all' ? s.spending.monthly : s.spending.monthly.slice(-24)
  const multiYear = new Set(months.map((m) => m.month.slice(0, 4))).size > 1
  const control = (
    <Segmented
      label="Chart range"
      value={range}
      onChange={setRange}
      options={[
        { id: '24', label: '24 months' },
        { id: 'all', label: 'All time' },
      ]}
    />
  )
  return { months, multiYear, control, range }
}

function ReturnsPanel() {
  const { s, open } = useDashboard()
  const r = s.returns
  const { months, multiYear, control, range } = useMonthWindow()
  const [by, setBy] = useState<'amount' | 'count'>('amount')
  const countByMonth = useMemo(() => new Map(r.byMonth.map((m) => [m.month, m])), [r])
  const top = by === 'amount' ? r.topByAmount : r.topByCount
  const linked = r.purchaseLinkedReturnRate

  return (
    <section aria-label="Returns" className="space-y-4">
      <h3 className="text-base font-semibold text-slate-900">Returns</h3>
      <dl className="grid grid-cols-1 gap-3 @pair:grid-cols-2 @spacious:grid-cols-4">
        <StatCard label="Returned merchandise" value={money(r.amountCents)} detail={r.withoutAmount.count > 0 ? `${count(r.withoutAmount.count)} without a recorded amount` : 'Recorded amounts'} />
        <StatCard label="Returns" value={count(r.count)} detail={`${count(r.distinctTransactions)} return transactions`} />
        <StatCard label="Quantity returned" value={count(r.quantity)} />
        <StatCard
          label="Returns as % of observed spend"
          value={share(r.observedReturnValueRatio)}
          hint="Recorded returned merchandise ÷ gross purchases in this data. Not a return rate: some returns may be for purchases from before the data begins."
        />
      </dl>
      <p role="note" className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-600" data-testid="returns-linkage">
        {linked.available
          ? `All returns are linked to their purchases: ${share(linked.rate)} of the linked purchases' value was returned.`
          : 'Returns are not linked to the purchase they came from, so a true return rate is not available. Figures compare returns with the purchases in this data only.'}{' '}
        {r.timeToReturn.available ? `Typical time to return: ${count(r.timeToReturn.medianDays)} days.` : 'Time from purchase to return is not available.'}
      </p>

      <Panel title="Returns by month" subtitle="Recorded returned merchandise value, by return date." actions={control}>
        <ColumnChart
          key={range}
          title="Returns by month chart"
          labels={months.map((m) => month(m.month))}
          axisLabels={months.map((m) => monthShort(m.month, multiYear))}
          series={[{ key: 'returns', label: 'Returned value', color: SERIES.orange, values: months.map((m) => m.refundCents) }]}
          formatValue={money}
          formatAxis={moneyAxis}
          height={200}
          footer={(i) => <span className="text-xs text-slate-500">{count(countByMonth.get(months[i]!.month)?.count ?? 0)} returns</span>}
          openLabel={() => 'View returns'}
          onOpen={(i) => {
            const m = months[i]!
            open({ kind: 'records', title: `Returns · ${month(m.month)}`, returnIds: countByMonth.get(m.month)?.ids ?? [] })
          }}
        />
        {r.undated.count > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            {count(r.undated.count)} returns have no date ({money(r.undated.amountCents)}).{' '}
            <DrillLink onClick={() => open({ kind: 'records', title: 'Undated returns', returnIds: r.undated.ids })}>View</DrillLink>
          </p>
        )}
        {r.byYear.length > 0 && (
          <p className="mt-2 text-xs text-slate-600">
            By year: {r.byYear.map((y) => `${y.year} ${money(y.amountCents)} (${count(y.count)})`).join(' · ')}
          </p>
        )}
      </Panel>

      <Panel
        title="Most returned items"
        actions={
          <Segmented
            label="Rank returned items by"
            value={by}
            onChange={setBy}
            options={[
              { id: 'amount', label: 'By value' },
              { id: 'count', label: 'By count' },
            ]}
          />
        }
      >
        {top.length === 0 ? (
          <p className="text-sm text-slate-600">No returns recorded.</p>
        ) : (
          <TableWrap label="Returned items table">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className={th}>Item</th>
                  <th scope="col" className={thNum}>Returns</th>
                  <th scope="col" className={thNum}>Qty</th>
                  <th scope="col" className={thNum}>Value</th>
                  <th scope="col" className={thNum} title="Returned quantity ÷ quantity bought in this data">
                    Returned ÷ bought
                  </th>
                </tr>
              </thead>
              <tbody>
                {top.map((i) => (
                  <tr key={i.itemNumber} className="border-b border-slate-100 last:border-0">
                    <td className={td}>
                      <DrillLink onClick={() => open({ kind: 'item', itemNumber: i.itemNumber })}>{i.description}</DrillLink>
                    </td>
                    <td className={tdNum}>{count(i.count)}</td>
                    <td className={tdNum}>{count(i.quantity)}</td>
                    <td className={tdNum}>{money(i.amountCents)}</td>
                    <td className={tdNum}>
                      {i.observedUnitReturnRatio === null ? (
                        <span className="text-slate-500" title="Not bought in this data">
                          not bought in data
                        </span>
                      ) : (
                        share(i.observedUnitReturnRatio, 0)
                      )}
                      {i.returnsExceedPurchases && (
                        <span className="ml-1.5">
                          <Badge tone="amber" title="More returned than bought in this data: some purchases predate the data.">
                            predates data
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
      </Panel>
    </section>
  )
}

function AdjustmentsPanel() {
  const { s, open } = useDashboard()
  const a = s.adjustments
  const { months, multiYear, control, range } = useMonthWindow()
  const byMonth = useMemo(() => new Map(a.byMonth.map((m) => [m.month, m])), [a])

  return (
    <section aria-label="Price adjustments" className="space-y-4">
      <h3 className="text-base font-semibold text-slate-900">Price adjustments</h3>
      <dl className="grid grid-cols-1 gap-3 @pair:grid-cols-2 @spacious:grid-cols-4">
        <StatCard label="Recovered" value={money(a.totalCents)} detail={`${count(a.count)} adjustments`} />
        <StatCard label="Average adjustment" value={money(a.averageCents)} />
        <StatCard
          label="Largest adjustment"
          value={money(a.largest?.amountCents)}
          detail={
            a.largest ? (
              <DrillLink onClick={() => open({ kind: 'item', itemNumber: a.largest!.itemNumber })}>
                {s.items.byItemNumber.get(a.largest.itemNumber)?.displayDescription ?? `Item ${a.largest.itemNumber}`} · {date(a.largest.date)}
              </DrillLink>
            ) : undefined
          }
        />
        <StatCard
          label="Price adjustments as % of observed spend"
          value={share(a.observedAdjustmentValueRatio, 2)}
          hint="Recorded adjustments ÷ gross purchases in this data. Not a savings rate: adjustments are not linked to a specific purchase."
          detail={`${share(a.observedAdjustedItemsValueRatio)} of spend on the adjusted items`}
        />
      </dl>
      <p role="note" className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-600" data-testid="adjustments-linkage">
        {a.purchaseLinkedSavingsRate.available
          ? `All adjustments are linked to their purchases: ${share(a.purchaseLinkedSavingsRate.rate)} of the linked purchases' value was recovered.`
          : 'Adjustments are matched to items by item number only and are not linked to a specific purchase, so a true savings rate is not available.'}
      </p>

      <Panel title="Adjustments by month" subtitle="Recorded price-adjustment refunds, by adjustment date." actions={control}>
        <ColumnChart
          key={range}
          title="Price adjustments by month chart"
          labels={months.map((m) => month(m.month))}
          axisLabels={months.map((m) => monthShort(m.month, multiYear))}
          series={[{ key: 'adj', label: 'Recovered', color: SERIES.aqua, values: months.map((m) => m.adjustmentCents) }]}
          formatValue={money}
          formatAxis={moneyAxis}
          height={200}
          footer={(i) => <span className="text-xs text-slate-500">{count(byMonth.get(months[i]!.month)?.count ?? 0)} adjustments</span>}
          openLabel={() => 'View adjustments'}
          onOpen={(i) => {
            const m = months[i]!
            open({ kind: 'records', title: `Price adjustments · ${month(m.month)}`, adjustmentIds: byMonth.get(m.month)?.ids ?? [] })
          }}
        />
        {a.undated.count > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            {count(a.undated.count)} adjustments have no date ({money(a.undated.amountCents)}).{' '}
            <DrillLink onClick={() => open({ kind: 'records', title: 'Undated price adjustments', adjustmentIds: a.undated.ids })}>View</DrillLink>
          </p>
        )}
      </Panel>

      <Panel title="Items with the most recovered">
        {a.topByAmount.length === 0 ? (
          <p className="text-sm text-slate-600">No price adjustments recorded.</p>
        ) : (
          <TableWrap label="Adjusted items table">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className={th}>Item</th>
                  <th scope="col" className={thNum}>Adjustments</th>
                  <th scope="col" className={thNum}>Recovered</th>
                  <th scope="col" className={thNum} title="Recovered ÷ spend on this item in the data">
                    % of item spend
                  </th>
                </tr>
              </thead>
              <tbody>
                {a.topByAmount.map((i) => (
                  <tr key={i.itemNumber} className="border-b border-slate-100 last:border-0">
                    <td className={td}>
                      <DrillLink onClick={() => open({ kind: 'item', itemNumber: i.itemNumber })}>{i.description}</DrillLink>
                    </td>
                    <td className={tdNum}>{count(i.count)}</td>
                    <td className={tdNum}>{money(i.amountCents)}</td>
                    <td className={tdNum}>{i.observedValueRatio === null ? <span className="text-slate-500">not bought in data</span> : share(i.observedValueRatio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>
    </section>
  )
}
