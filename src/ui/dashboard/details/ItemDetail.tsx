import { useMemo } from 'react'
import { dayNumber } from '../../../analytics/dates'
import { LineChart } from '../charts/LineChart'
import { SERIES } from '../charts/palette'
import { useDashboard } from '../context'
import { COHORT_LABEL } from '../derive'
import { change, count, date, days, daysBetween, money, moneyAxis, monthShort, share } from '../format'
import { DrillLink, Facts, Panel, StatCard, TableWrap, td, tdNum, th, thNum } from '../ui'
import { CategoryEditor } from './CategoryEditor'
import { warehouseText } from './text'

export function ItemDetail({ itemNumber }: { itemNumber: string }) {
  const { s, open, lookups, today } = useDashboard()
  const item = s.items.byItemNumber.get(itemNumber)
  const history = s.items.priceHistories.get(itemNumber)
  const lines = useMemo(() => (item ? item.lineIds.map((id) => lookups.lineById.get(id)!).reverse() : []), [item, lookups])
  if (!item || !history) return <p className="text-sm text-slate-600">This item is not in the current data.</p>

  const returns = item.returns.ids.map((id) => lookups.returnById.get(id)!)
  const adjustments = item.adjustments.ids.map((id) => lookups.adjustmentById.get(id)!)
  const ago = item.lastPurchaseDate ? daysBetween(item.lastPurchaseDate, today) : null
  const points = history.points

  return (
    <>
      <div className="space-y-1">
        <p className="text-sm text-slate-600">
          Item #{item.itemNumber} · {COHORT_LABEL[item.cohort]}
          {item.recent ? ' · recent' : ''}
        </p>
        {item.descriptions.length > 1 && (
          <p className="text-xs text-slate-500">Also recorded as: {item.descriptions.slice(1).join(' · ')}</p>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-4">
        <StatCard label="Total spend" value={money(item.totalSpentCents)} detail={`${count(item.lineCount)} item lines`} />
        <StatCard label="Quantity" value={count(item.totalQuantity)} />
        <StatCard label="Purchases" value={count(item.purchaseEvents)} detail={`${count(item.distinctMonths)} different months`} />
        <StatCard label="Latest price" value={money(item.latestUnitPriceCents)} detail={item.priceChange !== null ? `${change(item.priceChange)} since first price` : 'Recorded unit price'} />
      </dl>

      <Panel title="Category">
        <CategoryEditor key={`${item.category.source}:${item.category.categoryId}:${item.category.subcategoryId ?? ""}`} item={item} />
      </Panel>

      <Panel title="Purchase pattern">
        <Facts
          items={[
            ['First purchase', date(item.firstPurchaseDate)],
            ['Latest purchase', date(item.lastPurchaseDate)],
            ['Since latest purchase (as of today)', ago === null ? '—' : `${days(ago)} ago`],
            ['Typical gap between purchases', days(item.cadence.medianDays)],
            ['Average gap', days(item.cadence.meanDays)],
            ['Average unit price (quantity-weighted)', money(item.averageUnitPriceCents)],
            ['Warehouse / online purchases', `${count(item.bySource.warehouse)} / ${count(item.bySource.online)}`],
          ]}
        />
      </Panel>

      <Panel
        title="Price history"
        subtitle="Recorded unit prices after instant savings. Several purchases on one day are combined into one quantity-weighted point; the whisker shows their range."
      >
        {points.length === 0 ? (
          <p className="text-sm text-slate-600">
            No recorded unit price for this item{history.unpricedLines > 0 ? ` (${count(history.unpricedLines)} lines without a unit price)` : ''}. Prices are never estimated from
            line totals.
          </p>
        ) : (
          <>
            <LineChart
              title={`Unit price history for ${item.displayDescription}`}
              xs={points.map((p) => dayNumber(p.date))}
              labels={points.map((p) => date(p.date))}
              axisLabels={points.map((p) => monthShort(p.date, true))}
              series={[
                {
                  key: 'price',
                  label: 'Unit price',
                  color: SERIES.blue,
                  points: points.map((p) => ({ value: p.unitPriceCents, low: p.minCents, high: p.maxCents })),
                },
              ]}
              formatValue={money}
              formatAxis={moneyAxis}
              height={220}
              footer={(i) => {
                const p = points[i]!
                return (
                  <p className="mt-0.5 text-xs text-slate-500">
                    {p.observations === 1 ? '1 observation' : `${count(p.observations)} observations, ${money(p.minCents)}–${money(p.maxCents)}`} · qty {count(p.quantity)} ·{' '}
                    {p.sources.join(' & ')}
                  </p>
                )
              }}
            />
            <div className="mt-3">
              <Facts
                columns={3}
                items={[
                  ['First', money(history.firstCents)],
                  ['Latest', money(history.latestCents)],
                  ['First → latest', history.absoluteChangeCents === null ? '—' : `${history.absoluteChangeCents >= 0 ? '+' : '−'}${money(Math.abs(history.absoluteChangeCents))} (${change(history.percentChange)})`],
                  ['Lowest', money(history.minCents)],
                  ['Highest', money(history.maxCents)],
                  ['Median', money(history.medianCents)],
                  [
                    'Volatility',
                    history.volatility === null ? `Needs ${s.thresholds.volatilityMinPoints}+ price days` : `${share(history.volatility)} typical deviation`,
                  ],
                  ['Price changed between visits', history.changeFrequency === null ? '—' : share(history.changeFrequency, 0)],
                  ['Days with a price', count(points.length)],
                ]}
              />
            </div>
            {(history.unpricedLines > 0 || history.undatedPricedLines > 0) && (
              <p className="mt-2 text-xs text-slate-500">
                {history.unpricedLines > 0 && `${count(history.unpricedLines)} line(s) have no recorded unit price and are not shown. `}
                {history.undatedPricedLines > 0 && `${count(history.undatedPricedLines)} priced line(s) have no date and are not shown.`}
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel title="Purchases" subtitle="Newest first. Select a date to open the whole purchase.">
        {lines.length === 0 ? (
          <p className="text-sm text-slate-600">Not purchased in this data (only seen in returns or price adjustments).</p>
        ) : (
          <TableWrap label="Item purchases table">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className={th}>Date</th>
                  <th scope="col" className={th}>Where</th>
                  <th scope="col" className={thNum}>Qty</th>
                  <th scope="col" className={thNum}>Unit price</th>
                  <th scope="col" className={thNum}>Line total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100 last:border-0">
                    <td className={td}>
                      <DrillLink onClick={() => open({ kind: 'receipt', id: l.receiptId })}>{date(l.date)}</DrillLink>
                    </td>
                    <td className={`${td} max-w-[12rem] truncate text-slate-700`}>{lookups.warehouseLabelByReceipt.get(l.receiptId) ?? '—'}</td>
                    <td className={tdNum}>{count(l.quantity)}</td>
                    <td className={tdNum}>{l.unitPriceCents === null ? <span className="text-slate-500">not recorded</span> : money(l.unitPriceCents)}</td>
                    <td className={tdNum}>{money(l.lineTotalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="Returns" subtitle="Matched by item number only; not linked to a specific purchase.">
          {returns.length === 0 ? (
            <p className="text-sm text-slate-600">No returns recorded.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {returns.map((r) => (
                <li key={r.id} className="flex justify-between gap-3 border-b border-slate-100 pb-1.5">
                  <span>
                    {date(r.returnDate)} · qty {count(r.quantity)}
                    <span className="block text-xs text-slate-500">{warehouseText(r.warehouse)}</span>
                  </span>
                  <span className="tabular-nums">{r.merchandiseAmountCents === null ? <span className="text-slate-500">amount not recorded</span> : money(r.merchandiseAmountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Price adjustments" subtitle="Matched by item number only.">
          {adjustments.length === 0 ? (
            <p className="text-sm text-slate-600">No price adjustments recorded.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {adjustments.map((a) => (
                <li key={a.id} className="flex justify-between gap-3 border-b border-slate-100 pb-1.5">
                  <span>
                    {date(a.adjustmentDate)}
                    {a.adjustedQuantity !== null && ` · qty ${count(a.adjustedQuantity)}`}
                  </span>
                  <span className="tabular-nums">{money(a.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  )
}
