/**
 * Purchase events (warehouse receipts and online orders).
 *
 * - basket = Σ item lineTotalCents of the event (estimated, pre-tax; see
 *   PurchaseEvent.basketCents). Events with no exported lines have no basket
 *   and are left out of basket statistics (reported in `eventsWithoutLines`).
 * - intervals are measured between distinct purchase *days*: two receipts on
 *   the same day count as one shopping day for cadence and gaps.
 * - receipts keyed by a synthesized WHSE_ key may merge same-day trips at one
 *   warehouse (an iOS limitation), so counts are a lower bound; see quality.
 */
import { WEEKDAY_NAMES, dateFromDay, monthOfYear, weekday, type MonthKey } from './dates'
import type { AnalyticsIndex, PurchaseEvent } from './model'
import { mean, median, roundCents } from './stats'

export type EventSummary = {
  id: string
  date: string | null
  sourceType: PurchaseEvent['sourceType']
  warehouse: string | null
  basketCents: number
  lineCount: number
  units: number
}

export type TripAnalytics = {
  eventCount: number
  bySource: Record<PurchaseEvent['sourceType'], number>
  byMonth: { month: MonthKey; count: number; ids: string[] }[]
  byYear: { year: number; count: number; ids: string[] }[]
  undatedCount: number
  basket: {
    /** Events with at least one exported line (the basket population). */
    eventsWithBasket: number
    averageCents: number | null
    medianCents: number | null
    largest: EventSummary[]
    smallest: EventSummary[]
  }
  linesPerEvent: { average: number | null; median: number | null }
  eventsWithoutLines: { count: number; ids: string[] }
  intervals: {
    /** Distinct dated purchase days. */
    shoppingDays: number
    averageDays: number | null
    medianDays: number | null
    longestGap: { days: number; from: string; to: string } | null
  }
  /** Count of events by weekday (0 = Sunday) and month of year (1 = January); dated events only. */
  weekdays: { weekday: number; name: string; count: number }[]
  monthsOfYear: { month: number; count: number }[]
  busiestWeekdays: string[]
  busiestMonthsOfYear: number[]
  /** Calendar month (YYYY-MM) with the most events; ties listed. */
  busiestMonths: MonthKey[]
}

function summarize(e: PurchaseEvent): EventSummary {
  return {
    id: e.id,
    date: e.date,
    sourceType: e.sourceType,
    warehouse: e.warehouse,
    basketCents: e.basketCents ?? 0,
    lineCount: e.lineCount,
    units: e.units,
  }
}

export function computeTrips(index: AnalyticsIndex, topN: number): TripAnalytics {
  const events = index.events
  const bySource = { warehouse: 0, online: 0, synthetic: 0 }
  const byMonth = new Map<MonthKey, string[]>()
  const byYear = new Map<number, string[]>()
  const weekdays = new Array(7).fill(0) as number[]
  const monthsOfYear = new Array(12).fill(0) as number[]
  let undatedCount = 0

  for (const e of events) {
    bySource[e.sourceType] += 1
    if (e.date === null) {
      undatedCount += 1
      continue
    }
    byMonth.set(e.month!, [...(byMonth.get(e.month!) ?? []), e.id])
    byYear.set(e.year!, [...(byYear.get(e.year!) ?? []), e.id])
    weekdays[weekday(e.date)]! += 1
    monthsOfYear[monthOfYear(e.date) - 1]! += 1
  }

  const withBasket = events.filter((e) => e.basketCents !== null)
  const baskets = withBasket.map((e) => e.basketCents!)
  const byBasket = (dir: 1 | -1) =>
    [...withBasket]
      .sort((a, b) => dir * (a.basketCents! - b.basketCents!) || (a.id < b.id ? -1 : 1))
      .slice(0, topN)
      .map(summarize)

  const days = [...new Set(events.filter((e) => e.day !== null).map((e) => e.day!))].sort((a, b) => a - b)
  const gaps: { days: number; from: number; to: number }[] = []
  for (let i = 1; i < days.length; i++) gaps.push({ days: days[i]! - days[i - 1]!, from: days[i - 1]!, to: days[i]! })
  const longest = gaps.reduce<(typeof gaps)[number] | null>((best, g) => (best === null || g.days > best.days ? g : best), null)

  const maxIn = (counts: number[]) => Math.max(0, ...counts)
  const monthCounts = [...byMonth.entries()].map(([month, ids]) => ({ month, count: ids.length, ids }))
  const busiestMonthCount = maxIn(monthCounts.map((m) => m.count))

  return {
    eventCount: events.length,
    bySource,
    byMonth: monthCounts.sort((a, b) => (a.month < b.month ? -1 : 1)),
    byYear: [...byYear.entries()].map(([year, ids]) => ({ year, count: ids.length, ids })).sort((a, b) => a.year - b.year),
    undatedCount,
    basket: {
      eventsWithBasket: withBasket.length,
      averageCents: roundCents(mean(baskets)),
      medianCents: roundCents(median(baskets)),
      largest: byBasket(-1),
      smallest: byBasket(1),
    },
    linesPerEvent: { average: mean(withBasket.map((e) => e.lineCount)), median: median(withBasket.map((e) => e.lineCount)) },
    eventsWithoutLines: {
      count: events.length - withBasket.length,
      ids: events.filter((e) => e.basketCents === null).map((e) => e.id),
    },
    intervals: {
      shoppingDays: days.length,
      averageDays: mean(gaps.map((g) => g.days)),
      medianDays: median(gaps.map((g) => g.days)),
      longestGap: longest ? { days: longest.days, from: dateFromDay(longest.from), to: dateFromDay(longest.to) } : null,
    },
    weekdays: weekdays.map((count, i) => ({ weekday: i, name: WEEKDAY_NAMES[i]!, count })),
    monthsOfYear: monthsOfYear.map((count, i) => ({ month: i + 1, count })),
    busiestWeekdays: maxIn(weekdays) === 0 ? [] : weekdays.flatMap((c, i) => (c === maxIn(weekdays) ? [WEEKDAY_NAMES[i]!] : [])),
    busiestMonthsOfYear: maxIn(monthsOfYear) === 0 ? [] : monthsOfYear.flatMap((c, i) => (c === maxIn(monthsOfYear) ? [i + 1] : [])),
    busiestMonths: busiestMonthCount === 0 ? [] : monthCounts.filter((m) => m.count === busiestMonthCount).map((m) => m.month).sort(),
  }
}
