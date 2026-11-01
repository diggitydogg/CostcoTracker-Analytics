import { useState } from 'react'
import type { InflationSeries } from '../../../analytics'
import { LineChart } from '../charts/LineChart'
import { SERIES } from '../charts/palette'
import { useDashboard } from '../context'
import { change, count, month, monthShort, share } from '../format'
import { CONFIDENCE_TEXT } from '../confidence'
import { ConfidenceBadge, DrillLink, Panel, Segmented, StatCard, TableWrap, td, tdNum, th, thNum } from '../ui'

/**
 * "Your Costco price index": the engine's chained indexes. The weighted
 * personal-basket index leads; the simple matched-item index is context.
 * Values are always shown when the engine computed them; confidence is shown
 * next to every figure and low-confidence points are drawn hollow and dashed.
 */
export function InflationSection() {
  const { s, open } = useDashboard()
  const inf = s.inflation
  const sum = inf.summary
  const [granularity, setGranularity] = useState<'year' | 'month'>('year')
  const series: InflationSeries = granularity === 'year' ? inf.yearly : inf.monthly
  const latest = sum.latestYear
  const label = (p: string) => (granularity === 'year' ? p : month(p))

  return (
    <div className="space-y-4">
      <p className="max-w-4xl text-sm text-slate-600">
        How the prices of the things <em>you</em> buy repeatedly at Costco have changed, compared item by item between periods. This is a personal estimate from your own
        receipts, not an official inflation figure (CPI).
      </p>

      <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={latest ? `Your basket, ${latest.from} → ${latest.to}` : 'Your basket, latest year'}
          value={change(latest?.weightedChange)}
          hint="Weighted personal-basket index (Törnqvist): each matched item counts by its share of your spending."
          detail={latest ? <ConfidenceBadge confidence={latest.confidence} /> : 'Needs priced purchases in two years'}
        />
        <StatCard
          label="Matched items, same years"
          value={change(latest?.simpleChange)}
          hint="Simple matched-item index (Jevons): every matched item counts equally."
          detail={latest ? `${count(latest.matchedItems)} items · ${share(latest.spendCoverage)} of spend covered` : undefined}
        />
        <StatCard
          label={sum.firstYear && sum.lastYear && sum.firstYear !== sum.lastYear ? `Cumulative, ${sum.firstYear} → ${sum.lastYear}` : 'Cumulative change'}
          value={change(sum.cumulativeWeightedChange ?? sum.cumulativeSimpleChange)}
          hint="Chained across every year. A chain is only as strong as its weakest year."
          detail={
            sum.cumulativeWeightedChange === null && sum.cumulativeSimpleChange === null ? (
              'Not available: a year in the chain has no comparable items'
            ) : (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <ConfidenceBadge confidence={sum.cumulativeConfidence} />
                {sum.cumulativeWeightedChange === null && <span>simple index</span>}
              </span>
            )
          }
        />
        <StatCard
          label="Per year, annualized"
          value={change(sum.annualizedWeightedChange ?? sum.annualizedSimpleChange)}
          hint="The cumulative change spread evenly over the calendar years elapsed."
          detail={`${count(inf.eligibleItems)} items priced in 2+ years`}
        />
      </dl>

      {sum.reasons.length > 0 && (
        <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-medium">Read these figures with care</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {sum.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <Panel
        title="Your Costco price index"
        subtitle="First period = 100. Hollow points and dashed segments are not reliable (low coverage or insufficient data). Gaps mean nothing could be compared."
        actions={
          <Segmented
            label="Index granularity"
            value={granularity}
            onChange={setGranularity}
            options={[
              { id: 'year', label: 'Yearly' },
              { id: 'month', label: 'Monthly' },
            ]}
          />
        }
      >
        {series.periods.length < 2 ? (
          <p className="text-sm text-slate-600">Needs priced purchases of the same items in at least two {granularity === 'year' ? 'years' : 'months'}.</p>
        ) : (
          <LineChart
            key={granularity}
            title={`${granularity === 'year' ? 'Yearly' : 'Monthly'} personal price index`}
            xs={series.periods.map((_, i) => i)}
            labels={series.periods.map((p) => label(p.period))}
            axisLabels={series.periods.map((p) => (granularity === 'year' ? p.period : monthShort(p.period, true)))}
            baseline={100}
            series={[
              {
                key: 'weighted',
                label: 'Personal basket (weighted)',
                color: SERIES.blue,
                points: series.periods.map((p) => ({ value: p.weightedIndex, weak: p.chainConfidence !== null && p.chainConfidence !== 'reliable' })),
              },
              {
                key: 'simple',
                label: 'Matched items (simple)',
                color: SERIES.orange,
                dashed: true,
                points: series.periods.map((p) => ({ value: p.simpleIndex, weak: p.chainConfidence !== null && p.chainConfidence !== 'reliable' })),
              },
            ]}
            legendExtra={[{ label: 'Hollow point = not reliable', color: '#94a3b8', kind: 'dot' }]}
            formatValue={(v) => v.toFixed(1)}
            formatAxis={(v) => v.toFixed(0)}
            footer={(i) => {
              const p = series.periods[i]!
              return p.chainConfidence ? (
                <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-600">
                  Chain confidence <ConfidenceBadge confidence={p.chainConfidence} />
                </span>
              ) : (
                <span className="mt-1 block text-xs text-slate-500">Base period</span>
              )
            }}
            onOpen={(i) => {
              if (i > 0) open({ kind: 'inflation-link', granularity, index: i - 1 })
            }}
            openLabel={(i) => (i > 0 ? 'Matched items' : 'Base period')}
          />
        )}
      </Panel>

      <Panel title={granularity === 'year' ? 'Year-to-year changes' : 'Month-to-month changes'} subtitle="Select a period to see every matched item and its weight.">
        {series.links.length === 0 ? (
          <p className="text-sm text-slate-600">No periods to compare yet.</p>
        ) : (
          <TableWrap label="Price index links table">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className={th}>Period</th>
                  <th scope="col" className={thNum}>Personal basket</th>
                  <th scope="col" className={thNum}>Matched items</th>
                  <th scope="col" className={thNum}>Items compared</th>
                  <th scope="col" className={thNum}>Spend covered</th>
                  <th scope="col" className={th}>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {[...series.links]
                  .map((l, i) => ({ l, i }))
                  .reverse()
                  .map(({ l, i }) => (
                    <tr key={`${l.from}-${l.to}`} className={`border-b border-slate-100 last:border-0 ${l.confidence === 'reliable' ? '' : 'text-slate-600'}`}>
                      <td className={td}>
                        <DrillLink onClick={() => open({ kind: 'inflation-link', granularity, index: i })}>
                          {label(l.from)} → {label(l.to)}
                        </DrillLink>
                      </td>
                      <td className={`${tdNum} font-medium`}>{change(l.weightedChange)}</td>
                      <td className={tdNum}>{change(l.simpleChange)}</td>
                      <td className={tdNum}>{count(l.matchedItems)}</td>
                      <td className={tdNum}>{share(l.spendCoverage)}</td>
                      <td className={td} title={CONFIDENCE_TEXT[l.confidence].help}>
                        <ConfidenceBadge confidence={l.confidence} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Reliable = at least {s.thresholds.inflationMinMatchedItems} matched items covering at least {share(s.thresholds.inflationReliableMinSpendCoverage, 0)} of the two
          periods' spending. Price changes above {s.thresholds.inflationMaxRelative}× or below 1/{s.thresholds.inflationMaxRelative} are treated as pack-size changes and
          left out. Prices are after instant savings, so sales lower them.
        </p>
      </Panel>
    </div>
  )
}
