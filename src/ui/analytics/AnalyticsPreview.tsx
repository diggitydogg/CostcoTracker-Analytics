import { useMemo, type ReactNode } from 'react'
import { buildAnalyticsSnapshot, type DatasetSourceInfo, type InflationConfidence } from '../../analytics'
import type { AnalyticsExportV1 } from '../../domain/export/v1'
import { days, money, percent, share } from './format'

/**
 * Internal preview of the analytics engine: proves the snapshot works on real
 * data from either source. Not the final dashboard — no charts, minimal layout.
 */
export function AnalyticsPreview({ data, source }: { data: AnalyticsExportV1; source: DatasetSourceInfo }) {
  const s = useMemo(() => buildAnalyticsSnapshot(data, { source }), [data, source])
  const items = s.items.byItemNumber
  const latest = s.inflation.summary.latestYear

  return (
    <div className="space-y-4" data-testid="analytics-preview">
      <p className="text-sm text-slate-600">
        Preview of the analytics engine. Figures are pre-tax merchandise amounts; see “Data notes” below. As of {s.asOf ?? '—'}.
      </p>

      <Block title="Spending">
        <Facts
          facts={[
            ['Gross purchases', money(s.spending.lifetime.grossCents)],
            ['Refunds (returns)', money(s.spending.lifetime.refundCents)],
            ['Price adjustments', money(s.spending.lifetime.adjustmentCents)],
            ['Net spend', money(s.spending.lifetime.netCents)],
            ['Last 12 months (gross)', money(s.spending.rolling12.grossCents)],
            ['vs prior 12 months', percent(s.spending.rolling12.grossChange)],
            ['Average month', money(s.spending.averageMonthlyGrossCents)],
            ['Median month', money(s.spending.medianMonthlyGrossCents)],
          ]}
        />
      </Block>

      <Block title="Trips and orders">
        <Facts
          facts={[
            ['Purchase events', `${s.trips.eventCount} (${s.trips.bySource.warehouse} warehouse, ${s.trips.bySource.online} online)`],
            ['Average basket', money(s.trips.basket.averageCents)],
            ['Median basket', money(s.trips.basket.medianCents)],
            ['Typical gap between trips', days(s.trips.intervals.medianDays)],
            ['Longest gap', s.trips.intervals.longestGap ? `${s.trips.intervals.longestGap.days} days` : '—'],
            ['Busiest weekday', s.trips.busiestWeekdays.join(', ') || '—'],
          ]}
        />
      </Block>

      <Block title="Personal Costco inflation">
        {latest ? (
          <>
            <Facts
              facts={[
                [`${latest.from} → ${latest.to} (matched items)`, percent(latest.simpleChange)],
                ['Weighted personal basket', percent(latest.weightedChange)],
                ['Items compared', String(latest.matchedItems)],
                ['Share of spend represented', share(latest.spendCoverage)],
                ['Confidence', CONFIDENCE_LABEL[latest.confidence]],
              ]}
            />
            {s.inflation.summary.reasons.length > 0 && (
              <p className="mt-2 text-sm text-amber-800">{s.inflation.summary.reasons.join(' ')}</p>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-600">Needs priced purchases of the same items in at least two years.</p>
        )}
      </Block>

      <Block title="Top items by spend">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {s.items.topBySpend.slice(0, 5).map((n) => {
            const i = items.get(n)!
            return (
              <li key={n}>
                <span className="font-medium">{i.displayDescription}</span> — {money(i.totalSpentCents)}, {i.purchaseEvents} purchase
                {i.purchaseEvents === 1 ? '' : 's'}, {i.cohort.replace(/-/g, ' ')}
              </li>
            )
          })}
        </ol>
        <p className="mt-2 text-xs text-slate-600">
          {s.items.cohorts.staple.length} staples · {s.items.cohorts.occasional.length} occasional · {s.items.cohorts['one-and-done'].length}{' '}
          one-and-done · {s.items.cohorts['dormant-staple'].length} dormant staples
        </p>
      </Block>

      <Block title="Categories">
        <ul className="space-y-1 text-sm">
          {s.categories.categories.map((c) => (
            <li key={c.categoryId} className="flex justify-between gap-2">
              <span>{c.label}</span>
              <span className="tabular-nums">
                {money(c.spendCents)} · {share(c.spendShare)}
              </span>
            </li>
          ))}
        </ul>
      </Block>

      <Block title="Returns, adjustments and warehouses">
        <Facts
          facts={[
            ['Returns', `${s.returns.count} (${money(s.returns.amountCents)} recorded)`],
            ['Returns as % of observed spend', share(s.returns.observedReturnValueRatio)],
            ['Price adjustments', `${s.adjustments.count} (${money(s.adjustments.totalCents)})`],
            ['Adjustments as % of observed spend', share(s.adjustments.observedAdjustmentValueRatio)],
            ['Online share of spend', share(s.warehouses.channels.online.spendShare)],
            ['Warehouses / sources', String(s.warehouses.groups.length)],
          ]}
        />
      </Block>

      <Block title="Data notes">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          {s.quality.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Block>
    </div>
  )
}

const CONFIDENCE_LABEL: Record<InflationConfidence, string> = {
  insufficient: 'Insufficient data',
  'low-coverage': 'Low coverage',
  reliable: 'Reliable',
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-2 text-base font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Facts({ facts }: { facts: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {facts.map(([label, value]) => (
        <div key={label} className="flex min-w-0 justify-between gap-3 sm:block">
          <dt className="text-slate-600">{label}</dt>
          <dd className="font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
