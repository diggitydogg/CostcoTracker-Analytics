import type { ReactNode } from 'react'
import type { InflationConfidence } from '../../analytics'
import { CONFIDENCE_TEXT } from './confidence'
import { share } from './format'

/** A titled panel. `id` makes it a landmark region for screen readers and tests. */
export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    // A size container: grids inside adapt to the panel's own width (a column, a pane, a sheet), not the window.
    <section
      aria-labelledby={id}
      className={`@container min-w-0 rounded-xl border border-slate-200 bg-white p-[var(--panel-pad)] shadow-[0_1px_2px_rgba(15,23,42,0.04)] [--panel-pad:1rem] @regular:[--panel-pad:1.25rem] ${className}`}
    >
      <header className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 id={id} className="text-[0.9375rem] font-semibold text-slate-900">
            {title}
          </h3>
          {/* Explanations stay at a readable line length even in a wide panel. */}
          {subtitle && <p className="mt-0.5 max-w-readable text-xs text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

/** A headline number. */
export function StatCard({ label, value, detail, hint }: { label: string; value: string; detail?: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <dt className="flex items-center gap-1 text-xs font-medium text-slate-500">
        <span>{label}</span>
        {hint && <InfoTip text={hint} />}
      </dt>
      {/* Never truncate a figure people compare: wrap as a last resort instead. */}
      <dd className="mt-1 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] text-slate-900 tabular-nums">{value}</dd>
      {detail && <dd className="mt-1 text-xs text-slate-600">{detail}</dd>}
    </div>
  )
}

/** Small "i" with a native tooltip and an accessible name; the text is also exposed to screen readers. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex h-[1.4em] w-[1.4em] shrink-0 cursor-help items-center justify-center rounded-full border border-slate-300 text-[0.5625rem] font-semibold text-slate-500">
      <span aria-hidden>i</span>
      <span className="sr-only">{text}</span>
    </span>
  )
}

/** Inline list of label/value pairs. */
export function Facts({ items, columns = 2 }: { items: [string, ReactNode][]; columns?: 1 | 2 | 3 }) {
  const cols = columns === 1 ? '' : columns === 2 ? '@regular:grid-cols-2' : '@regular:grid-cols-2 @spacious:grid-cols-3'
  return (
    <dl className={`grid grid-cols-1 gap-x-6 gap-y-2 text-sm ${cols}`}>
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5">
          <dt className="text-slate-600">{k}</dt>
          <dd className="text-right font-medium tabular-nums text-slate-900">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Badge({ children, tone = 'slate', title }: { children: ReactNode; tone?: 'slate' | 'sky' | 'green' | 'amber' | 'red' | 'violet'; title?: string }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700 ring-slate-200',
    sky: 'bg-sky-50 text-sky-800 ring-sky-200',
    green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    amber: 'bg-amber-50 text-amber-900 ring-amber-200',
    red: 'bg-red-50 text-red-800 ring-red-200',
    violet: 'bg-violet-50 text-violet-800 ring-violet-200',
  }
  return (
    // Badges stay on one line at normal text sizes; only when larger text leaves no room do they wrap instead of overflowing.
    <span title={title} className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  )
}

/** Status badge with an icon and a label, so confidence is never conveyed by color alone. */
export function ConfidenceBadge({ confidence }: { confidence: InflationConfidence | null }) {
  if (confidence === null) return <Badge>No comparison yet</Badge>
  const t = CONFIDENCE_TEXT[confidence]
  const tone = confidence === 'reliable' ? 'green' : confidence === 'low-coverage' ? 'amber' : 'red'
  const icon = confidence === 'reliable' ? '✓' : confidence === 'low-coverage' ? '!' : '×'
  return (
    <Badge tone={tone} title={t.help}>
      <span aria-hidden>{icon}</span>
      {t.label}
    </Badge>
  )
}

/** Horizontal bars as HTML: label, value and share always visible as text. */
export function BarList({
  rows,
  color = '#2a78d6',
  label,
}: {
  rows: { key: string; label: ReactNode; value: string; fraction: number | null; detail?: ReactNode; onClick?: () => void; accessibleLabel?: string }[]
  color?: string
  label: string
}) {
  const max = Math.max(0, ...rows.map((r) => r.fraction ?? 0))
  return (
    <ul aria-label={label} className="space-y-1.5">
      {rows.map((r) => {
        const width = max > 0 && r.fraction !== null ? Math.max(0.5, (r.fraction / max) * 100) : 0
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-slate-800">{r.label}</span>
              <span className="shrink-0 tabular-nums text-slate-900">
                <span className="font-medium">{r.value}</span>
                {r.fraction !== null && <span className="ml-2 inline-block w-12 text-right text-xs text-slate-500">{share(r.fraction)}</span>}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-slate-100">
              <div className="h-1.5 rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
            </div>
            {r.detail && <div className="mt-0.5 text-xs text-slate-500">{r.detail}</div>}
          </>
        )
        return (
          <li key={r.key}>
            {r.onClick ? (
              <button type="button" onClick={r.onClick} aria-label={r.accessibleLabel} className="block w-full rounded-md px-1.5 py-1 text-left hover:bg-slate-50">
                {body}
              </button>
            ) : (
              <div className="px-1.5 py-1">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly { id: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg bg-slate-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${value === o.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-600">{children}</p>
}

/** A link-styled button for drill-down. */
export function DrillLink({ onClick, children, label }: { onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="text-left font-medium text-sky-800 underline decoration-sky-300 underline-offset-2 hover:decoration-sky-700">
      {children}
    </button>
  )
}

/** Scrollable table wrapper: tables keep their columns and scroll sideways on narrow screens. */
export function TableWrap({ children, label }: { children: ReactNode; label: string }) {
  return (
    // Compact: the table bleeds to the panel edges and scrolls sideways; the panel's padding is reused so they always match.
    <div className="-mx-[var(--panel-pad,1rem)] overflow-x-auto overscroll-x-contain px-[var(--panel-pad,1rem)] @regular:mx-0 @regular:px-0" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  )
}

export const th = 'whitespace-nowrap px-2 py-2 text-left text-xs font-medium text-slate-500'
export const thNum = 'whitespace-nowrap px-2 py-2 text-right text-xs font-medium text-slate-500'
export const td = 'px-2 py-2 align-top'
export const tdNum = 'whitespace-nowrap px-2 py-2 text-right align-top tabular-nums'
