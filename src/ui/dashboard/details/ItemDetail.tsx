import { useMemo, useState } from 'react'
import { isOwnerConfirmed, resolutionBasisLabel, type ProductIdentity } from '../../../analytics/products/identityProtocol'
import { dayNumber } from '../../../analytics/dates'
import { LineChart } from '../charts/LineChart'
import { SERIES } from '../charts/palette'
import { useDashboard } from '../context'
import { COHORT_LABEL } from '../derive'
import { change, count, date, days, daysBetween, money, moneyAxis, monthShort, share } from '../format'
import { Badge, DrillLink, Facts, Panel, StatCard, TableWrap, td, tdNum, th, thNum } from '../ui'
import { buildSuggestionItems } from '../../../analytics/categories/suggestProtocol'
import { CategoryEditor } from './CategoryEditor'
import { IdentityForm } from './IdentityForm'
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
        {item.identity ? (
          <ProductIdentityLine key={`${item.identity.canonicalName}|${item.identity.resolvedAt}`} itemName={item.displayDescription} identity={item.identity} />
        ) : (
          <ConfirmIdentityLine itemNumber={item.itemNumber} itemName={item.displayDescription} descriptions={item.descriptions} />
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

const smallBtn = 'rounded-md px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40'

/** Our catalog record for the item. Owner-confirmed records can be edited or removed here (cloud mode); automatic ones cannot. */
function ProductIdentityLine({ itemName, identity }: { itemName: string; identity: ProductIdentity }) {
  const { catalog } = useDashboard()
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const owner = isOwnerConfirmed(identity)
  const editable = owner && catalog !== null

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await catalog!.remove(identity.itemNumber)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove. Try again.')
      setBusy(false)
    }
  }

  return (
    <div data-testid="product-identity-block">
      <p className="text-xs text-slate-600" data-testid="product-identity">
        In your product catalog as <span className="font-medium text-slate-900">{identity.canonicalName}</span>
        {identity.brand && ` · ${identity.brand}`}
        {identity.productType && ` · ${identity.productType}`} ·{' '}
        {owner ? (
          <>
            <Badge tone="sky">Owner confirmed</Badge> on {date(identity.resolvedAt)}
          </>
        ) : (
          <>
            {share(identity.confidence, 0)} confidence · resolved {`from ${resolutionBasisLabel(identity.basis)}`} on {date(identity.resolvedAt)}
            {identity.method === 'web-search+ai' ? ' (name normalized by AI)' : ''}
          </>
        )}
      </p>
      {editable && mode === 'view' && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setMode('edit')} className={`${smallBtn} border border-slate-300 bg-white hover:bg-slate-100`}>
            Edit identity
          </button>
          <button type="button" onClick={() => setMode('remove')} className={`${smallBtn} border border-red-300 bg-white text-red-800 hover:bg-red-50`}>
            Remove identity
          </button>
        </div>
      )}
      {editable && mode === 'edit' && (
        <IdentityForm
          itemName={itemName}
          initial={identity}
          submitLabel="Save changes"
          onCancel={() => setMode('view')}
          onSubmit={async (fields) => {
            await catalog!.update(identity.itemNumber, fields)
            setMode('view')
          }}
        />
      )}
      {editable && mode === 'remove' && (
        <div role="group" aria-label="Remove identity" className="mt-1 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-950">
          <p>Remove this product identity from your catalog? Receipts, purchases and category choices are not changed. The item may be looked up again later.</p>
          {error && <p role="alert">{error}</p>}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" disabled={busy} onClick={() => void remove()} className={`${smallBtn} bg-red-800 text-white hover:bg-red-700`}>
              {busy ? 'Removing…' : 'Remove'}
            </button>
            <button type="button" disabled={busy} onClick={() => setMode('view')} className={`${smallBtn} border border-slate-300 bg-white`}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * For an item with no resolved catalog identity (cloud mode): the owner can
 * confirm what the product is, directly from the drawer. Opening or saving
 * never searches or calls the AI. The name is prefilled only from a possible
 * match already shown in this session; otherwise it starts empty.
 */
function ConfirmIdentityLine({ itemNumber, itemName, descriptions }: { itemNumber: string; itemName: string; descriptions: readonly string[] }) {
  const { catalog, ai } = useDashboard()
  const [open, setOpen] = useState(false)
  // The same sanitized receipt text the lookup sends (single-line, bounded); none → cannot be confirmed here.
  const receipt = buildSuggestionItems([{ itemNumber, descriptions }])[0]?.descriptions[0]
  if (!catalog || !receipt) return null
  const possible = ai?.possibleMatches.get(itemNumber)
  return (
    <div data-testid="confirm-identity-block">
      {possible && <p className="text-xs text-slate-600">Possible match (one unconfirmed source, not saved or used): {possible}</p>}
      {open ? (
        <IdentityForm
          itemName={itemName}
          initial={{ canonicalName: possible ?? '' }}
          submitLabel="Save to my catalog"
          onCancel={() => setOpen(false)}
          onSubmit={(fields) => catalog.confirm(itemNumber, receipt, fields)}
        />
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={`${smallBtn} mt-1 border border-sky-300 bg-white text-sky-900 hover:bg-sky-50`}>
          Confirm identity
        </button>
      )}
    </div>
  )
}
