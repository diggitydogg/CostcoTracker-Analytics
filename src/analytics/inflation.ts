/**
 * Personal Costco inflation index.
 *
 * Price observations: item lines with a recorded unitPriceCents and a date.
 * Period price of item i in period t (a calendar year or month):
 *     p_i(t) = Σ(unit_price × qty) / Σ qty  over the item's priced lines in t.
 * Item spend in t, s_i(t) = Σ lineTotalCents of those priced lines.
 *
 * Periods are the years (or months) that contain dated purchases, in order.
 * Each consecutive pair (a → b) is a LINK. Only items priced in BOTH a and b
 * ("matched items", M) enter the link, so one-off products and new products
 * never distort it. Relative r_i = p_i(b) / p_i(a). Relatives outside
 * [1/maxRelative, maxRelative] are treated as pack-size/product changes under
 * the same item number and excluded (counted in outliersExcluded).
 *
 *  (a) Simple matched-item link (Jevons): L = geometric mean of r_i over M.
 *  (b) Weighted personal-basket link (Törnqvist):
 *        w_i = ½ (s_i(a)/Σ_M s(a) + s_i(b)/Σ_M s(b)),   L = exp(Σ w_i ln r_i)
 *      Expenditure shares from both periods account for changing basket
 *      composition. Only computed with ≥ weightedMinItems matched items.
 *
 * Index: I(first period) = 100, I(b) = I(a) × L (chained). A link with no
 * usable matched items breaks the chain; later values are null rather than
 * guessed. Links spanning gaps (e.g. 2023 → 2025, or Jan → Mar) compare the
 * two observed periods directly.
 *
 * Coverage of a link = (Σ_M s(a) + Σ_M s(b)) / (all item spend in a and b).
 * A link is "reliable" only with ≥ minMatchedItems matched items AND coverage
 * ≥ minSpendCoverage. Annualized rates use calendar years elapsed.
 *
 * Limitations: unit prices are net of instant savings (a sale lowers the
 * observed price); pack-size changes under one item number are only caught by
 * the outlier guard; lines without a recorded unit price are not observed.
 * This is a personal price-change estimate, not an official CPI.
 */
import type { AnalyticsThresholds } from './config'
import type { MonthKey } from './dates'
import type { AnalyticsIndex } from './model'
import { geometricMean, ratio } from './stats'

export type InflationGranularity = 'year' | 'month'

export type InflationLinkItem = {
  itemNumber: string
  fromPriceCents: number
  toPriceCents: number
  relative: number
  /** Törnqvist weight; null when the weighted link was not computed. */
  weight: number | null
}

export type InflationLink = {
  from: string
  to: string
  matchedItems: number
  outliersExcluded: number
  /** Simple matched-item (Jevons) price relative; 1.05 = +5%. */
  simpleRelative: number | null
  /** Weighted personal-basket (Törnqvist) price relative. */
  weightedRelative: number | null
  simpleChange: number | null
  weightedChange: number | null
  /** Share of the two periods' item spend represented by the matched items. */
  spendCoverage: number | null
  reliable: boolean
  items: InflationLinkItem[]
}

export type InflationPeriod = { period: string; simpleIndex: number | null; weightedIndex: number | null }

export type InflationSeries = {
  granularity: InflationGranularity
  periods: InflationPeriod[]
  links: InflationLink[]
  reliableLinks: number
}

export type InflationAnalytics = {
  yearly: InflationSeries
  monthly: InflationSeries
  /** Items with recorded prices in at least two different years. */
  eligibleItems: number
  summary: {
    latestYear: InflationLink | null
    firstYear: string | null
    lastYear: string | null
    cumulativeSimpleChange: number | null
    cumulativeWeightedChange: number | null
    annualizedSimpleChange: number | null
    annualizedWeightedChange: number | null
    /** False when the latest yearly link is missing or not reliable. */
    sufficientData: boolean
    reasons: string[]
  }
}

type PeriodStats = { price: number; spend: number }

function periodKey(date: string, granularity: InflationGranularity): string {
  return granularity === 'year' ? date.slice(0, 4) : (date.slice(0, 7) as MonthKey)
}

export function inflationSeries(
  index: AnalyticsIndex,
  granularity: InflationGranularity,
  t: AnalyticsThresholds,
): InflationSeries {
  // item → period → {Σ unit×qty, Σ qty, Σ spend}; and period → all item spend.
  const acc = new Map<string, Map<string, { weighted: number; qty: number; spend: number }>>()
  const periodTotals = new Map<string, number>()
  for (const line of index.lines) {
    if (line.date === null) continue
    const p = periodKey(line.date, granularity)
    periodTotals.set(p, (periodTotals.get(p) ?? 0) + line.lineTotalCents)
    if (line.unitPriceCents === null) continue
    let byPeriod = acc.get(line.itemNumber)
    if (!byPeriod) acc.set(line.itemNumber, (byPeriod = new Map()))
    const cell = byPeriod.get(p) ?? { weighted: 0, qty: 0, spend: 0 }
    cell.weighted += line.unitPriceCents * line.quantity
    cell.qty += line.quantity
    cell.spend += line.lineTotalCents
    byPeriod.set(p, cell)
  }
  const prices = new Map<string, Map<string, PeriodStats>>()
  for (const [item, byPeriod] of acc) {
    const m = new Map<string, PeriodStats>()
    for (const [p, c] of byPeriod) if (c.qty > 0) m.set(p, { price: c.weighted / c.qty, spend: c.spend })
    prices.set(item, m)
  }

  const periods = [...periodTotals.keys()].sort()
  const links: InflationLink[] = []
  for (let k = 1; k < periods.length; k++) {
    const a = periods[k - 1]!
    const b = periods[k]!
    const matched: { itemNumber: string; pa: PeriodStats; pb: PeriodStats; relative: number }[] = []
    let outliers = 0
    for (const [item, byPeriod] of prices) {
      const pa = byPeriod.get(a)
      const pb = byPeriod.get(b)
      if (!pa || !pb || !(pa.price > 0) || !(pb.price > 0)) continue
      const relative = pb.price / pa.price
      if (relative > t.inflationMaxRelative || relative < 1 / t.inflationMaxRelative) {
        outliers += 1
        continue
      }
      matched.push({ itemNumber: item, pa, pb, relative })
    }
    matched.sort((x, y) => (x.itemNumber < y.itemNumber ? -1 : 1))

    const simple = geometricMean(matched.map((m) => m.relative))
    let weighted: number | null = null
    let weights: number[] | null = null
    const sumA = matched.reduce((s, m) => s + m.pa.spend, 0)
    const sumB = matched.reduce((s, m) => s + m.pb.spend, 0)
    if (matched.length >= t.inflationWeightedMinItems && sumA > 0 && sumB > 0) {
      weights = matched.map((m) => (m.pa.spend / sumA + m.pb.spend / sumB) / 2)
      weighted = Math.exp(matched.reduce((s, m, i) => s + weights![i]! * Math.log(m.relative), 0))
    }
    const coverage = ratio(sumA + sumB, (periodTotals.get(a) ?? 0) + (periodTotals.get(b) ?? 0))
    links.push({
      from: a,
      to: b,
      matchedItems: matched.length,
      outliersExcluded: outliers,
      simpleRelative: simple,
      weightedRelative: weighted,
      simpleChange: simple === null ? null : simple - 1,
      weightedChange: weighted === null ? null : weighted - 1,
      spendCoverage: coverage,
      reliable: matched.length >= t.inflationMinMatchedItems && coverage !== null && coverage >= t.inflationMinSpendCoverage,
      items: matched.map((m, i) => ({
        itemNumber: m.itemNumber,
        fromPriceCents: m.pa.price,
        toPriceCents: m.pb.price,
        relative: m.relative,
        weight: weights ? weights[i]! : null,
      })),
    })
  }

  const series: InflationPeriod[] = periods.map((period) => ({ period, simpleIndex: null, weightedIndex: null }))
  if (series.length > 0) {
    series[0]!.simpleIndex = 100
    series[0]!.weightedIndex = 100
  }
  for (let k = 1; k < series.length; k++) {
    const link = links[k - 1]!
    const prev = series[k - 1]!
    series[k]!.simpleIndex = prev.simpleIndex !== null && link.simpleRelative !== null ? prev.simpleIndex * link.simpleRelative : null
    series[k]!.weightedIndex =
      prev.weightedIndex !== null && link.weightedRelative !== null ? prev.weightedIndex * link.weightedRelative : null
  }

  return { granularity, periods: series, links, reliableLinks: links.filter((l) => l.reliable).length }
}

export function computeInflation(index: AnalyticsIndex, t: AnalyticsThresholds): InflationAnalytics {
  const yearly = inflationSeries(index, 'year', t)
  const monthly = inflationSeries(index, 'month', t)

  const yearsByItem = new Map<string, Set<string>>()
  for (const line of index.lines) {
    if (line.date === null || line.unitPriceCents === null) continue
    const set = yearsByItem.get(line.itemNumber) ?? new Set<string>()
    set.add(line.date.slice(0, 4))
    yearsByItem.set(line.itemNumber, set)
  }
  const eligibleItems = [...yearsByItem.values()].filter((s) => s.size >= 2).length

  const first = yearly.periods[0] ?? null
  const last = yearly.periods[yearly.periods.length - 1] ?? null
  const latestYear = yearly.links[yearly.links.length - 1] ?? null
  const years = first && last ? Number(last.period) - Number(first.period) : 0
  const cumulative = (v: number | null | undefined) => (v === null || v === undefined || !last || last === first ? null : v / 100 - 1)
  const annualize = (c: number | null) => (c === null || years <= 0 ? null : Math.pow(1 + c, 1 / years) - 1)
  const cumulativeSimple = cumulative(last?.simpleIndex)
  const cumulativeWeighted = cumulative(last?.weightedIndex)

  const reasons: string[] = []
  if (yearly.periods.length < 2) reasons.push('Fewer than two years of dated, priced purchases.')
  if (latestYear && latestYear.matchedItems < t.inflationMinMatchedItems) {
    reasons.push(`Only ${latestYear.matchedItems} item(s) were bought with a recorded price in both ${latestYear.from} and ${latestYear.to}; at least ${t.inflationMinMatchedItems} are needed.`)
  }
  if (latestYear && latestYear.spendCoverage !== null && latestYear.spendCoverage < t.inflationMinSpendCoverage) {
    reasons.push('The matched items represent too small a share of spending to be representative.')
  }
  if (latestYear && latestYear.weightedRelative === null) {
    reasons.push('Not enough matched items for the weighted personal-basket index.')
  }

  return {
    yearly,
    monthly,
    eligibleItems,
    summary: {
      latestYear,
      firstYear: first?.period ?? null,
      lastYear: last?.period ?? null,
      cumulativeSimpleChange: cumulativeSimple,
      cumulativeWeightedChange: cumulativeWeighted,
      annualizedSimpleChange: annualize(cumulativeSimple),
      annualizedWeightedChange: annualize(cumulativeWeighted),
      sufficientData: latestYear !== null && latestYear.reliable,
      reasons,
    },
  }
}
