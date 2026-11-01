import { useState } from 'react'
import type { InflationSeries } from '../../../analytics'
import { LineChart } from '../charts/LineChart'
import { SERIES } from '../charts/palette'
import { useDashboard } from '../context'
import { chainBreaks, describeBreak } from '../derive'
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
  const yearlyBreak = chainBreaks(inf.yearly)
  // The cumulative cards use the weighted chain, falling back to the simple chain (as before).
  const cumulativeBreak = sum.cumulativeWeightedChange === null && sum.cumulativeSimpleChange === null ? (yearlyBreak.simple ?? yearlyBreak.weighted) : null
  const breaks = chainBreaks(series)
  const unit = granularity === 'year' ? 'year' : 'month'

  return (
    <div className="space-y-4">
      <p className="max-w-4xl text-sm text-slate-600">
        How the prices of the things <em>you</em> buy repeatedly at Costco have changed, compared item by item between periods. This is a personal estimate from your own
        receipts, not an official inflation figure (CPI).
      </p>

      <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={latest ? `Your basket, year over year (${latest.from} → ${latest.to})` : 'Your basket, year over year'}
          value={change(latest?.weightedChange)}
          hint="Weighted personal-basket index (Törnqvist): each matched item counts by its share of your spending. Compares only these two years."
          detail={latest ? <ConfidenceBadge confidence={latest.confidence} /> : 'Needs priced purchases in two years'}
        />
        <StatCard
          label={latest ? `Matched items, year over year (${latest.from} → ${latest.to})` : 'Matched items, year over year'}
          value={change(latest?.simpleChange)}
          hint="Simple matched-item index (Jevons): every matched item counts equally."
          detail={latest ? `${count(latest.matchedItems)} items · ${share(latest.spendCoverage)} of spend covered` : undefined}
        />
        <StatCard
          label={sum.firstYear && sum.lastYear && sum.firstYear !== sum.lastYear ? `Cumulative, ${sum.firstYear} → ${sum.lastYear}` : 'Cumulative change'}
          value={cumulativeBreak ? 'Not available' : change(sum.cumulativeWeightedChange ?? sum.cumulativeSimpleChange)}
          hint="Chained across every year. A chain is only as strong as its weakest year, and a year with nothing to compare breaks it."
          detail={
            cumulativeBreak ? (
              <span data-testid="cumulative-break">
                Chain broken at {cumulativeBreak.from} → {cumulativeBreak.to}: {describeBreak(cumulativeBreak)}. Year-over-year results are unaffected.
              </span>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <ConfidenceBadge confidence={sum.cumulativeConfidence} />
                {sum.cumulativeWeightedChange === null && sum.cumulativeSimpleChange !== null && <span>simple index</span>}
              </span>
            )
          }
        />
        <StatCard
          label="Per year, annualized"
          value={cumulativeBreak ? 'Not available' : change(sum.annualizedWeightedChange ?? sum.annualizedSimpleChange)}
          hint="The cumulative change spread evenly over the calendar years elapsed."
          detail={cumulativeBreak ? 'Needs an unbroken cumulative chain' : `${count(inf.eligibleItems)} items priced in 2+ years`}
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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Index granularity"
          value={granularity}
          onChange={setGranularity}
          options={[
            { id: 'year', label: 'Yearly' },
            { id: 'month', label: 'Monthly' },
          ]}
        />
        <p className="text-xs text-slate-500">Applies to the two panels below.</p>
      </div>

      <Panel
        title={granularity === 'year' ? 'Year-over-year changes' : 'Month-over-month changes'}
        subtitle={`Each row compares two consecutive ${unit}s on its own; it stays valid even when an earlier ${unit} breaks the cumulative chain. Select a row to see every matched item and its weight.`}
      >
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
                      {l.matchedItems === 0 ? (
                        <td className={`${td} text-right italic`} colSpan={2}>
                          No comparable items
                        </td>
                      ) : (
                        <>
                          <td className={`${tdNum} font-medium`}>{change(l.weightedChange)}</td>
                          <td className={tdNum}>{change(l.simpleChange)}</td>
                        </>
                      )}
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

      <Panel
        title="Cumulative price index (chained)"
        subtitle={`First ${unit} = 100; each ${unit} multiplies the previous value by that ${unit}'s change. Hollow points and dashed segments are not reliable. A ${unit} with nothing to compare breaks the chain: later ${unit}s then have no cumulative value (it is never bridged), but their own changes above remain valid.`}
      >
        {series.periods.length < 2 ? (
          <p className="text-sm text-slate-600">Needs priced purchases of the same items in at least two {unit}s.</p>
        ) : (
          <>
            {(breaks.weighted || breaks.simple) && (
              <p className="mb-2 text-xs text-slate-700" data-testid="chain-break-note">
                {breaks.simple
                  ? `Chain broken at ${label(breaks.simple.from)} → ${label(breaks.simple.to)}: ${describeBreak(breaks.simple, label)}. No cumulative value is shown from ${label(breaks.simple.to)} on.`
                  : `The weighted chain breaks at ${label(breaks.weighted!.from)} → ${label(breaks.weighted!.to)}: ${describeBreak(breaks.weighted!, label)}. The simple chain continues.`}
              </p>
            )}
            <LineChart
              key={granularity}
              title={`${granularity === 'year' ? 'Yearly' : 'Monthly'} cumulative personal price index`}
              xs={series.periods.map((_, i) => i)}
              labels={series.periods.map((p) => label(p.period))}
              axisLabels={series.periods.map((p) => (granularity === 'year' ? p.period : monthShort(p.period, true)))}
              baseline={100}
              gaps={series.links.flatMap((l, i) => (l.matchedItems === 0 ? [{ index: i + 1, label: 'no comparable items' }] : []))}
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
              footer={(i) => <IndexFooter series={series} index={i} label={label} unit={unit} />}
              onOpen={(i) => {
                if (i > 0) open({ kind: 'inflation-link', granularity, index: i - 1 })
              }}
              openLabel={(i) => (i > 0 ? 'Matched items' : 'Base period')}
            />
          </>
        )}
      </Panel>
    </div>
  )
}

/** Readout footer: the period's own change (always shown when valid) and why a cumulative value is missing. */
function IndexFooter({ series, index, label, unit }: { series: InflationSeries; index: number; label: (p: string) => string; unit: string }) {
  const p = series.periods[index]!
  if (index === 0) return <span className="mt-1 block text-xs text-slate-500">Base {unit} (= 100)</span>
  const link = series.links[index - 1]!
  const breaks = chainBreaks(series)
  const broken = [breaks.weighted, breaks.simple].filter((b) => b !== null && b.linkIndex <= index - 1)
  const anyChained = p.weightedIndex !== null || p.simpleIndex !== null
  return (
    <span className="mt-1 block space-y-0.5 text-xs text-slate-600" data-testid="index-footer">
      <span className="flex flex-wrap items-center gap-1.5">
        <span>
          {label(link.from)} → {label(link.to)} on its own:{' '}
          {link.matchedItems === 0 ? (
            'no comparable items'
          ) : (
            <>
              <strong className="text-slate-900">{change(link.weightedChange)}</strong> weighted · {change(link.simpleChange)} simple
            </>
          )}
        </span>
        <ConfidenceBadge confidence={link.confidence} />
      </span>
      {broken.length > 0 && !anyChained && (
        <span className="block text-slate-500">
          Cumulative value not available: chain broken at {label(broken[0]!.from)} → {label(broken[0]!.to)}.
        </span>
      )}
      {anyChained && p.chainConfidence && (
        <span className="flex items-center gap-1.5">
          Chain confidence <ConfidenceBadge confidence={p.chainConfidence} />
        </span>
      )}
    </span>
  )
}
