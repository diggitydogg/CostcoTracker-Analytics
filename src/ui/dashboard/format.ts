/**
 * Display formatting for the dashboard. Every formatter returns "—" for a
 * missing or non-finite value, so NaN, Infinity or "undefined" can never be
 * shown to the user.
 */
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
const monthFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' })
const shortMonthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })

export const DASH = '—'
const ok = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

export function money(cents: number | null | undefined): string {
  return ok(cents) ? usd.format(cents / 100) : DASH
}

/** Whole dollars for headline figures and axes. */
export function moneyWhole(cents: number | null | undefined): string {
  return ok(cents) ? usdWhole.format(Math.round(cents / 100)) : DASH
}

/** Compact axis label: $950, $1.2k, $15k. */
export function moneyAxis(cents: number): string {
  if (!ok(cents)) return DASH
  const d = cents / 100
  const a = Math.abs(d)
  const sign = d < 0 ? '−' : ''
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return `${sign}$${a.toFixed(a !== Math.round(a) ? 2 : 0)}`
}

/** Signed change: +4.2%. */
export function change(fraction: number | null | undefined, digits = 1): string {
  if (!ok(fraction)) return DASH
  const v = Number((fraction * 100).toFixed(digits))
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%`
}

/** Unsigned share: 12.5%. */
export function share(fraction: number | null | undefined, digits = 1): string {
  return ok(fraction) ? `${(fraction * 100).toFixed(digits)}%` : DASH
}

export function count(n: number | null | undefined): string {
  return ok(n) ? plain.format(n) : DASH
}

export function days(n: number | null | undefined): string {
  if (!ok(n)) return DASH
  const r = Math.round(n)
  return `${r} ${r === 1 ? 'day' : 'days'}`
}

export function date(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? DASH : dateFmt.format(d)
}

export function month(key: string | null | undefined): string {
  if (!key) return DASH
  const d = new Date(`${key.slice(0, 7)}-01T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? DASH : monthFmt.format(d)
}

/** "Jan" — or "Jan ’24" when `withYear`. */
export function monthShort(key: string, withYear = false): string {
  const d = new Date(`${key.slice(0, 7)}-01T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return DASH
  return withYear ? `${shortMonthFmt.format(d)} ’${key.slice(2, 4)}` : shortMonthFmt.format(d)
}

/** Whole days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/** Today's date (UTC calendar) as YYYY-MM-DD. */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}
