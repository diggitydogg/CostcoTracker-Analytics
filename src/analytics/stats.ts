/**
 * Small numeric helpers. All return `null` instead of NaN/Infinity when a
 * statistic is undefined (empty input, zero denominator), so analytics output
 * never contains non-finite numbers.
 */

export function sum(values: readonly number[]): number {
  let total = 0
  for (const v of values) total += v
  return total
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Population standard deviation. */
export function stddev(values: readonly number[]): number | null {
  const m = mean(values)
  if (m === null) return null
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / values.length)
}

export function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0 || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return null
  const r = numerator / denominator
  return Number.isFinite(r) ? r : null
}

/** Relative change from `from` to `to` (0.05 = +5%); null when `from` is 0. */
export function relativeChange(from: number, to: number): number | null {
  return from === 0 ? null : ratio(to - from, from)
}

/** Rounds a cents value that came from division back to whole cents. */
export function roundCents(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value)
}

/** Removes floating-point noise from summed fractional quantities (6 decimals). */
export function cleanQuantity(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Geometric mean of positive values; null if empty or any value is not positive. */
export function geometricMean(values: readonly number[]): number | null {
  if (values.length === 0 || values.some((v) => !(v > 0))) return null
  return Math.exp(sum(values.map(Math.log)) / values.length)
}

/** Groups items by a key, preserving insertion order. */
export function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k)
    if (list) list.push(item)
    else map.set(k, [item])
  }
  return map
}

export function topBy<T>(items: readonly T[], score: (item: T) => number, n: number, tieBreak: (a: T, b: T) => number): T[] {
  return [...items].sort((a, b) => score(b) - score(a) || tieBreak(a, b)).slice(0, n)
}
