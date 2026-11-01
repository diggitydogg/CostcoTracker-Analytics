/**
 * Per-item price history.
 *
 * Observations are item lines with a recorded `unitPriceCents` and a date.
 * A unit price is NEVER derived from lineTotalCents / quantity: the iOS export
 * leaves unitPriceCents null exactly when the stored net unit price is not a
 * whole number of cents (e.g. $10.00 over 3 units), and inventing a value would
 * add false precision. Such lines are counted in `unpricedLines`.
 *
 * Observations on the same date (several lines, several receipts, warehouse
 * and online) collapse into one daily point priced at the quantity-weighted
 * mean, Σ(unit × qty) / Σ qty, rounded to whole cents; the point keeps its min,
 * max and observation count so nothing is hidden.
 *
 * Biggest increase/decrease: the largest step in cents between consecutive
 * daily points; ties go to the larger relative change, then the later step.
 *
 * Volatility = coefficient of variation of the daily point prices: population
 * standard deviation ÷ mean. It is scale-free (0.10 ≈ prices typically 10% from
 * their mean) and only reported with at least `volatilityMinPoints` points.
 * `changeFrequency` = share of consecutive points whose price differs.
 */
import type { PurchaseLine } from './model'
import { mean, median, relativeChange, roundCents, stddev } from './stats'

export type PricePoint = {
  date: string
  unitPriceCents: number
  minCents: number
  maxCents: number
  observations: number
  quantity: number
  sources: PurchaseLine['sourceType'][]
  lineIds: string[]
}

export type PriceStep = { fromDate: string; toDate: string; fromCents: number; toCents: number; changeCents: number; change: number | null }

export type PriceHistory = {
  itemNumber: string
  points: PricePoint[]
  firstCents: number | null
  latestCents: number | null
  absoluteChangeCents: number | null
  /** Relative change first → latest; null with fewer than 2 points or a zero first price. */
  percentChange: number | null
  minCents: number | null
  maxCents: number | null
  meanCents: number | null
  medianCents: number | null
  volatility: number | null
  changeFrequency: number | null
  biggestIncrease: PriceStep | null
  biggestDecrease: PriceStep | null
  /** Lines without a recorded unit price (no price point; never estimated). */
  unpricedLines: number
  /** Priced lines whose receipt has no date (cannot be placed on a timeline). */
  undatedPricedLines: number
}

export function priceHistory(itemNumber: string, lines: readonly PurchaseLine[], volatilityMinPoints: number): PriceHistory {
  const byDate = new Map<string, PurchaseLine[]>()
  let unpricedLines = 0
  let undatedPricedLines = 0
  for (const line of lines) {
    if (line.unitPriceCents === null) {
      unpricedLines += 1
      continue
    }
    if (line.date === null) {
      undatedPricedLines += 1
      continue
    }
    const list = byDate.get(line.date)
    if (list) list.push(line)
    else byDate.set(line.date, [line])
  }

  const points: PricePoint[] = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, obs]) => {
      let weighted = 0
      let qty = 0
      for (const o of obs) {
        weighted += o.unitPriceCents! * o.quantity
        qty += o.quantity
      }
      const prices = obs.map((o) => o.unitPriceCents!)
      return {
        date,
        unitPriceCents: Math.round(weighted / qty),
        minCents: Math.min(...prices),
        maxCents: Math.max(...prices),
        observations: obs.length,
        quantity: Math.round(qty * 1e6) / 1e6,
        sources: [...new Set(obs.map((o) => o.sourceType))].sort(),
        lineIds: obs.map((o) => o.id),
      }
    })

  const prices = points.map((p) => p.unitPriceCents)
  const first = points[0]
  const latest = points[points.length - 1]
  const steps: PriceStep[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    steps.push({
      fromDate: a.date,
      toDate: b.date,
      fromCents: a.unitPriceCents,
      toCents: b.unitPriceCents,
      changeCents: b.unitPriceCents - a.unitPriceCents,
      change: relativeChange(a.unitPriceCents, b.unitPriceCents),
    })
  }
  // Largest absolute cents step; ties go to the larger relative change, then the later step.
  const rel = (s: PriceStep) => Math.abs(s.change ?? 0)
  const increase =
    steps.filter((s) => s.changeCents > 0).sort((a, b) => b.changeCents - a.changeCents || rel(b) - rel(a) || (a.toDate < b.toDate ? 1 : -1))[0] ?? null
  const decrease =
    steps.filter((s) => s.changeCents < 0).sort((a, b) => a.changeCents - b.changeCents || rel(b) - rel(a) || (a.toDate < b.toDate ? 1 : -1))[0] ?? null
  const m = mean(prices)
  const sd = stddev(prices)

  return {
    itemNumber,
    points,
    firstCents: first?.unitPriceCents ?? null,
    latestCents: latest?.unitPriceCents ?? null,
    absoluteChangeCents: points.length >= 2 ? latest!.unitPriceCents - first!.unitPriceCents : null,
    percentChange: points.length >= 2 ? relativeChange(first!.unitPriceCents, latest!.unitPriceCents) : null,
    minCents: points.length ? Math.min(...points.map((p) => p.minCents)) : null,
    maxCents: points.length ? Math.max(...points.map((p) => p.maxCents)) : null,
    meanCents: roundCents(m),
    medianCents: roundCents(median(prices)),
    volatility: points.length >= volatilityMinPoints && m !== null && m > 0 && sd !== null ? sd / m : null,
    changeFrequency: steps.length === 0 ? null : steps.filter((s) => s.changeCents !== 0).length / steps.length,
    biggestIncrease: increase,
    biggestDecrease: decrease,
    unpricedLines,
    undatedPricedLines,
  }
}
