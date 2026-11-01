/**
 * Per-itemNumber analytics and cohorts.
 *
 * - purchaseEvents = distinct receipts/orders containing the item.
 * - averageUnitPriceCents = quantity-weighted mean of RECORDED unit prices,
 *   Σ(unit × qty) / Σ qty over lines with a unit price (never derived from
 *   line totals). First/latest/min/max come from the item's price history.
 * - cadence = gaps in days between distinct dated purchase days of the item.
 * - returns/adjustments are matched to items by itemNumber only (the export
 *   never links them to a specific purchase).
 *
 * Cohorts (thresholds in config.ts):
 * - "staple": ≥ stapleMinEvents purchase events across ≥ stapleMinDistinctMonths
 *   distinct months, and not dormant;
 * - "dormant-staple": meets the staple bar but unbought for longer than
 *   max(dormantCadenceMultiplier × median cadence, dormantMinDays);
 * - "occasional": ≥ occasionalMinEvents events but not a staple;
 * - "one-and-done": exactly one purchase event;
 * - "not-purchased": only seen in returns/adjustments (bought outside the data).
 * `recent` (last purchase within recentDays of as-of) is an independent flag.
 */
import { identityTexts, type ProductIdentities, type ProductIdentity } from './products/identityProtocol'
import type { AnalyticsThresholds } from './config'
import { categorize, normalizeDescription, type CategoryAssignment, type CategoryOverrides } from './categories/engine'
import type { CategoryRule } from './categories/rules'
import { dateFromDay } from './dates'
import type { AnalyticsIndex, PurchaseLine } from './model'
import { priceHistory, type PriceHistory } from './prices'
import { cleanQuantity, mean, median, roundCents } from './stats'

export type ItemCohort = 'staple' | 'dormant-staple' | 'occasional' | 'one-and-done' | 'not-purchased'

export type ItemStats = {
  itemNumber: string
  displayDescription: string
  /** Distinct description variants, most recent first. */
  descriptions: string[]
  category: CategoryAssignment
  /** Public product identity found by web search for this item number (identified or provisional), for display and traceability. */
  identity: ProductIdentity | null
  cohort: ItemCohort
  recent: boolean
  firstPurchaseDate: string | null
  lastPurchaseDate: string | null
  daysSinceLastPurchase: number | null
  purchaseEvents: number
  distinctMonths: number
  lineCount: number
  totalQuantity: number
  totalSpentCents: number
  bySource: Record<PurchaseLine['sourceType'], number>
  pricedLineCount: number
  averageUnitPriceCents: number | null
  firstUnitPriceCents: number | null
  latestUnitPriceCents: number | null
  minUnitPriceCents: number | null
  maxUnitPriceCents: number | null
  priceChangeCents: number | null
  priceChange: number | null
  cadence: { intervals: number; meanDays: number | null; medianDays: number | null }
  returns: { count: number; quantity: number; amountCents: number; withoutAmount: number; ids: string[] }
  adjustments: { count: number; amountCents: number; ids: string[] }
  receiptIds: string[]
  lineIds: string[]
}

export type ItemAnalytics = {
  /**
   * Every item number in the data: purchased ones AND ones seen only in
   * returns or price adjustments (cohort "not-purchased", e.g. bought before
   * the data begins). `items.length === itemCounts.all`.
   */
  items: ItemStats[]
  byItemNumber: Map<string, ItemStats>
  priceHistories: Map<string, PriceHistory>
  cohorts: Record<ItemCohort | 'recent', string[]>
  /**
   * all = every item number (= items.length);
   * purchased = item numbers with at least one purchase line in the data;
   * returnsOrAdjustmentsOnly = all − purchased.
   */
  itemCounts: { all: number; purchased: number; returnsOrAdjustmentsOnly: number }
  topBySpend: string[]
  topByEvents: string[]
}

export function computeItems(
  index: AnalyticsIndex,
  thresholds: AnalyticsThresholds,
  overrides: CategoryOverrides,
  rules: readonly CategoryRule[] | undefined,
  identities: ProductIdentities = {},
): ItemAnalytics {
  const returnsByItem = new Map<string, typeof index.returns>()
  for (const r of index.returns) returnsByItem.set(r.itemNumber, [...(returnsByItem.get(r.itemNumber) ?? []), r])
  const adjustmentsByItem = new Map<string, typeof index.adjustments>()
  for (const a of index.adjustments) adjustmentsByItem.set(a.itemNumber, [...(adjustmentsByItem.get(a.itemNumber) ?? []), a])

  const itemNumbers = new Set([...index.linesByItem.keys(), ...returnsByItem.keys(), ...adjustmentsByItem.keys()])
  const items: ItemStats[] = []
  const priceHistories = new Map<string, PriceHistory>()

  for (const itemNumber of [...itemNumbers].sort()) {
    const lines = index.linesByItem.get(itemNumber) ?? []
    const returns = returnsByItem.get(itemNumber) ?? []
    const adjustments = adjustmentsByItem.get(itemNumber) ?? []

    // Descriptions, most recent first (lines are date-ordered; returns as a fallback source).
    const descriptions: string[] = []
    for (const d of [...lines].reverse().map((l) => l.description).concat(returns.map((r) => r.description ?? ''))) {
      const n = normalizeDescription(d)
      if (n && !descriptions.includes(n)) descriptions.push(n)
    }

    const history = priceHistory(itemNumber, lines, thresholds.volatilityMinPoints)
    priceHistories.set(itemNumber, history)

    const receiptIds = [...new Set(lines.map((l) => l.receiptId))]
    const days = [...new Set(lines.filter((l) => l.day !== null).map((l) => l.day!))].sort((a, b) => a - b)
    const gaps = days.slice(1).map((d, i) => d - days[i]!)
    const months = new Set(lines.filter((l) => l.month !== null).map((l) => l.month!))
    const priced = lines.filter((l) => l.unitPriceCents !== null)
    const pricedQty = priced.reduce((s, l) => s + l.quantity, 0)
    const weighted = priced.reduce((s, l) => s + l.unitPriceCents! * l.quantity, 0)
    const lastDay = days[days.length - 1] ?? null
    const daysSince = lastDay !== null && index.asOfDay !== null ? index.asOfDay - lastDay : null
    const medianCadence = median(gaps)

    const purchaseEvents = receiptIds.length
    let cohort: ItemCohort
    if (purchaseEvents === 0) cohort = 'not-purchased'
    else if (purchaseEvents === 1) cohort = 'one-and-done'
    else if (purchaseEvents >= thresholds.stapleMinEvents && months.size >= thresholds.stapleMinDistinctMonths) {
      const dormantAfter = Math.max(thresholds.dormantCadenceMultiplier * (medianCadence ?? 0), thresholds.dormantMinDays)
      cohort = daysSince !== null && daysSince > dormantAfter ? 'dormant-staple' : 'staple'
    } else if (purchaseEvents >= thresholds.occasionalMinEvents) cohort = 'occasional'
    else cohort = 'one-and-done'

    const bySource = { warehouse: 0, online: 0, synthetic: 0 }
    for (const id of receiptIds) bySource[index.eventsById.get(id)!.sourceType] += 1

    items.push({
      itemNumber,
      displayDescription: descriptions[0] ?? `Item ${itemNumber}`,
      descriptions,
      category: categorize(itemNumber, descriptions, overrides, rules, identityTexts(identities[itemNumber])),
      // Identified and provisional identities are shown for traceability; only usable ones feed the rules (identityTexts).
      identity: identities[itemNumber] && identities[itemNumber].status !== 'not_found' ? identities[itemNumber] : null,
      cohort,
      recent: daysSince !== null && daysSince <= thresholds.recentDays,
      firstPurchaseDate: days.length ? dateFromDay(days[0]!) : null,
      lastPurchaseDate: lastDay !== null ? dateFromDay(lastDay) : null,
      daysSinceLastPurchase: daysSince,
      purchaseEvents,
      distinctMonths: months.size,
      lineCount: lines.length,
      totalQuantity: cleanQuantity(lines.reduce((s, l) => s + l.quantity, 0)),
      totalSpentCents: lines.reduce((s, l) => s + l.lineTotalCents, 0),
      bySource,
      pricedLineCount: priced.length,
      averageUnitPriceCents: pricedQty > 0 ? roundCents(weighted / pricedQty) : null,
      firstUnitPriceCents: history.firstCents,
      latestUnitPriceCents: history.latestCents,
      minUnitPriceCents: history.minCents,
      maxUnitPriceCents: history.maxCents,
      priceChangeCents: history.absoluteChangeCents,
      priceChange: history.percentChange,
      cadence: { intervals: gaps.length, meanDays: mean(gaps), medianDays: medianCadence },
      returns: {
        count: returns.length,
        quantity: cleanQuantity(returns.reduce((s, r) => s + r.quantity, 0)),
        amountCents: returns.reduce((s, r) => s + (r.merchandiseAmountCents ?? 0), 0),
        withoutAmount: returns.filter((r) => r.merchandiseAmountCents === null).length,
        ids: returns.map((r) => r.id),
      },
      adjustments: {
        count: adjustments.length,
        amountCents: adjustments.reduce((s, a) => s + a.amountCents, 0),
        ids: adjustments.map((a) => a.id),
      },
      receiptIds,
      lineIds: lines.map((l) => l.id),
    })
  }

  const cohorts: ItemAnalytics['cohorts'] = {
    staple: [],
    'dormant-staple': [],
    occasional: [],
    'one-and-done': [],
    'not-purchased': [],
    recent: [],
  }
  for (const item of items) {
    cohorts[item.cohort].push(item.itemNumber)
    if (item.recent) cohorts.recent.push(item.itemNumber)
  }
  const purchased = items.filter((i) => i.purchaseEvents > 0)
  const rank = (score: (i: ItemStats) => number) =>
    [...purchased].sort((a, b) => score(b) - score(a) || (a.itemNumber < b.itemNumber ? -1 : 1)).slice(0, thresholds.topN).map((i) => i.itemNumber)

  return {
    items,
    byItemNumber: new Map(items.map((i) => [i.itemNumber, i])),
    priceHistories,
    cohorts,
    itemCounts: { all: items.length, purchased: purchased.length, returnsOrAdjustmentsOnly: items.length - purchased.length },
    topBySpend: rank((i) => i.totalSpentCents),
    topByEvents: rank((i) => i.purchaseEvents),
  }
}
