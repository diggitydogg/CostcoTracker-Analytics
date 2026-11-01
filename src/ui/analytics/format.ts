/** Display formatting for the analytics preview. */
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function money(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '—' : usd.format(cents / 100)
}

export function percent(fraction: number | null | undefined, digits = 1): string {
  if (fraction === null || fraction === undefined) return '—'
  const sign = fraction > 0 ? '+' : ''
  return `${sign}${(fraction * 100).toFixed(digits)}%`
}

export function share(fraction: number | null | undefined): string {
  return fraction === null || fraction === undefined ? '—' : `${(fraction * 100).toFixed(1)}%`
}

export function days(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `${Math.round(n)} days`
}
