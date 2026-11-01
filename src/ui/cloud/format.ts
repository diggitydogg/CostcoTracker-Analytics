import type { SyncRun } from '../../cloud/api'

/** Display helpers for cloud timestamps (ISO-8601 UTC from the API) in the viewer's local time. */

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "in 9 minutes", "3 hours ago", "just now". */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const diffMs = new Date(iso).getTime() - now.getTime()
  const abs = Math.abs(diffMs)
  if (abs < 45_000) return diffMs >= 0 ? 'in under a minute' : 'just now'
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ]
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'minute') return rtf.format(Math.round(diffMs / ms), unit)
  }
  return rtf.format(Math.round(diffMs / 60_000), 'minute')
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export const RUN_STATUS_LABEL = {
  open: 'In progress',
  completed: 'Completed',
  needs_review: 'Needs your review',
  aborted: 'Cancelled',
  abandoned: 'Stopped before finishing',
} as const

export const REQUEST_STATUS_LABEL = {
  pending: 'Waiting for iPhone',
  acknowledged: 'iPhone is syncing',
  fulfilled: 'Done',
  expired: 'Not picked up',
} as const

/** What a sync run changed, per record kind (items travel with their receipt). */
export function runSummary(run: SyncRun): string {
  const kinds = [
    ['receipt', run.receipts_inserted, run.receipts_updated + run.receipts_revived, run.receipts_unchanged],
    ['return', run.returns_inserted, run.returns_updated + run.returns_revived, run.returns_unchanged],
    ['price adjustment', run.adjustments_inserted, run.adjustments_updated + run.adjustments_revived, run.adjustments_unchanged],
  ] as const
  const parts: string[] = []
  for (const [label, added] of kinds) if (added > 0) parts.push(plural(added, `new ${label}`))
  for (const [label, , changed] of kinds) if (changed > 0) parts.push(plural(changed, `updated ${label}`))
  const unchanged = kinds.reduce((n, k) => n + k[3], 0)
  if (unchanged > 0) parts.push(`${unchanged.toLocaleString()} already up to date`)
  if (run.marked_missing > 0) parts.push(`${run.marked_missing.toLocaleString()} no longer on iPhone`)
  return parts.length > 0 ? parts.join(' · ') : run.status === 'open' ? 'Receiving data…' : 'No changes'
}
