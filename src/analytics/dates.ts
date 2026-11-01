/**
 * Calendar-date helpers. Purchase/return/adjustment dates are calendar days
 * (YYYY-MM-DD) with no time zone; they are converted to whole "day numbers"
 * (days since 1970-01-01) using UTC arithmetic only, so no local time zone can
 * shift a day.
 */

const DAY_MS = 86_400_000

export type MonthKey = string // "YYYY-MM"

export function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

export function dateFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

export function monthKey(date: string): MonthKey {
  return date.slice(0, 7)
}

export function yearOf(date: string): number {
  return Number(date.slice(0, 4))
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay()
}

/** 1 … 12. */
export function monthOfYear(date: string): number {
  return Number(date.slice(5, 7))
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7)) - 1 + delta
  const year = y + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return `${String(year).padStart(4, '0')}-${String(mm + 1).padStart(2, '0')}`
}

/** Every month from `first` to `last` inclusive (empty if first > last). */
export function monthRange(first: MonthKey, last: MonthKey): MonthKey[] {
  const out: MonthKey[] = []
  for (let m = first; m <= last; m = addMonths(m, 1)) out.push(m)
  return out
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
