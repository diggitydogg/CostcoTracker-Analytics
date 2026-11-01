/**
 * Every tunable threshold of the analytics engine, in one place.
 * Changing a value here changes the behaviour everywhere it is used; the
 * documentation (docs/ANALYTICS_ENGINE.md) describes what each one controls.
 */
export type AnalyticsThresholds = {
  /** Item cohorts (by number of distinct purchase events containing the item). */
  stapleMinEvents: number
  /** A staple must also span at least this many distinct months. */
  stapleMinDistinctMonths: number
  /** Items bought in this many events (inclusive range) are "occasional repeat" buys. */
  occasionalMinEvents: number
  /** "Recently purchased": last purchase within this many days of the as-of date. */
  recentDays: number
  /** A staple is "dormant" when unbought for max(dormantCadenceMultiplier × median cadence, dormantMinDays). */
  dormantCadenceMultiplier: number
  dormantMinDays: number

  /** Price volatility needs at least this many dated price points. */
  volatilityMinPoints: number

  /**
   * Inflation: a period link with fewer matched items than this is
   * "insufficient" (its simple index is still shown when computable).
   */
  inflationMinMatchedItems: number
  /** Inflation: the weighted (Törnqvist) link is only computed with at least this many matched items. */
  inflationWeightedMinItems: number
  /**
   * Inflation: a link with enough matched items is "reliable" only when the
   * matched items cover at least this share of the two periods' item spend;
   * below it the link is "low-coverage".
   */
  inflationReliableMinSpendCoverage: number
  /** Inflation: price relatives outside [1/x, x] are treated as product/pack-size changes and excluded. */
  inflationMaxRelative: number

  /** How many entries "top N" lists contain. */
  topN: number
}

export const DEFAULT_THRESHOLDS: AnalyticsThresholds = {
  stapleMinEvents: 4,
  stapleMinDistinctMonths: 3,
  occasionalMinEvents: 2,
  recentDays: 30,
  dormantCadenceMultiplier: 3,
  dormantMinDays: 120,
  volatilityMinPoints: 3,
  inflationMinMatchedItems: 5,
  inflationWeightedMinItems: 5,
  inflationReliableMinSpendCoverage: 0.2,
  inflationMaxRelative: 3,
  topN: 10,
}
