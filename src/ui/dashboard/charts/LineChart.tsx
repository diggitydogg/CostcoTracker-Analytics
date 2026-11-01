import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Legend } from './ColumnChart'
import { SERIES } from './palette'
import { linear, niceTicks } from './scale'
import { useElementWidth } from './useElementWidth'

export type LinePoint = {
  value: number | null
  /** Optional observed range at this x (e.g. min/max of same-day prices). */
  low?: number | null
  high?: number | null
  /** Weak points (e.g. low-confidence index values) get a hollow marker and a dashed segment into them. */
  weak?: boolean
}

export type LineSeries = { key: string; label: string; color: string; dashed?: boolean; points: readonly LinePoint[] }

type Props = {
  title: string
  /** Numeric x positions (e.g. day numbers or period indexes), ascending. */
  xs: readonly number[]
  /** Full label of each x, used in the readout. */
  labels: readonly string[]
  axisLabels: readonly string[]
  series: readonly LineSeries[]
  formatValue: (v: number) => string
  formatAxis: (v: number) => string
  baseline?: number
  height?: number
  footer?: (index: number) => ReactNode
  onOpen?: (index: number) => void
  openLabel?: (index: number) => string
  /** Extra legend entries (e.g. what a hollow marker means). */
  legendExtra?: { label: string; color: string; kind: 'box' | 'line' | 'dashed' | 'dot' }[]
  /** Breaks between point index-1 and index, drawn as a labelled band (e.g. a broken index chain). */
  gaps?: { index: number; label: string }[]
}

const M = { top: 10, right: 12, bottom: 22, left: 56 }

/**
 * Line chart over a numeric x axis with a crosshair readout. Missing values
 * break the line (never interpolated); observed ranges draw as whiskers.
 */
export function LineChart({
  title,
  xs,
  labels,
  axisLabels,
  series,
  formatValue,
  formatAxis,
  baseline,
  height = 240,
  footer,
  onOpen,
  openLabel,
  legendExtra = [],
  gaps = [],
}: Props) {
  const n = xs.length
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [active, setActive] = useState(n - 1)
  const idx = Math.max(0, Math.min(n - 1, active))
  const descId = useId()
  if (n === 0) {
    return <p className="rounded-md border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-600">Nothing to chart yet.</p>
  }

  const values: number[] = []
  for (const s of series)
    for (const p of s.points) for (const v of [p.value, p.low, p.high]) if (typeof v === 'number' && Number.isFinite(v)) values.push(v)
  if (baseline !== undefined) values.push(baseline)
  const vMin = values.length ? Math.min(...values) : 0
  const vMax = values.length ? Math.max(...values) : 1
  const ticks = niceTicks(vMin, vMax, 4)
  const plotW = Math.max(40, width - M.left - M.right)
  const plotH = height - M.top - M.bottom
  const y = linear(ticks[0]!, ticks[ticks.length - 1]!, M.top + plotH, M.top)
  const x0 = xs[0]!
  const x1 = xs[n - 1]!
  const x = n === 1 ? () => M.left + plotW / 2 : linear(x0, x1, M.left + 8, M.left + plotW - 8)
  // Keep axis labels at least 64px apart, always labelling the latest point.
  const shownLabels = new Set<number>()
  for (let i = n - 1, lastX = Infinity; i >= 0; i--) {
    const px = x(xs[i]!)
    if (lastX - px >= 64) {
      shownLabels.add(i)
      lastX = px
    }
  }
  const showMarkers = n <= 80

  const select = (i: number) => setActive(Math.max(0, Math.min(n - 1, i)))
  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n }
    if (e.key in step) {
      e.preventDefault()
      select(idx + step[e.key]!)
    } else if ((e.key === 'Enter' || e.key === ' ') && onOpen) {
      e.preventDefault()
      onOpen(idx)
    }
  }
  const nearest = (px: number) => {
    let best = 0
    for (let i = 1; i < n; i++) if (Math.abs(x(xs[i]!) - px) < Math.abs(x(xs[best]!) - px)) best = i
    return best
  }

  return (
    <figure className="space-y-2">
      <Legend items={[...series.map((s) => ({ label: s.label, color: s.color, kind: s.dashed ? ('dashed' as const) : ('line' as const) })), ...legendExtra]} />
      <div aria-live="polite" className="flex min-h-12 flex-wrap items-end justify-between gap-x-4 gap-y-1 rounded-md bg-slate-50 px-3 py-2 text-sm" data-testid="chart-readout">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500">{labels[idx]}</p>
          <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
            {series.map((s) => {
              const p = s.points[idx]
              return (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ backgroundColor: s.color }} />
                  <dt className="text-slate-600">{s.label}</dt>
                  <dd className="font-semibold tabular-nums text-slate-900">{p && p.value !== null ? formatValue(p.value) : 'not available'}</dd>
                </div>
              )
            })}
          </dl>
          {footer?.(idx)}
        </div>
        {onOpen && (
          <button type="button" onClick={() => onOpen(idx)} className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100">
            {openLabel ? openLabel(idx) : 'Details'}
          </button>
        )}
      </div>
      <div ref={ref} className="w-full">
        <svg
          role="group"
          aria-label={`${title}. Use left and right arrow keys to move between points.`}
          aria-describedby={descId}
          tabIndex={0}
          onKeyDown={onKey}
          width={width}
          height={height}
          className="block touch-pan-y select-none rounded focus-visible:outline-2 focus-visible:outline-sky-600"
          onPointerMove={(e) => {
            const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
            if (box.width > 0) select(nearest(e.clientX - box.left))
          }}
          onClick={(e) => {
            const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
            const i = box.width > 0 ? nearest(e.clientX - box.left) : idx
            if (i === idx) onOpen?.(i)
            else select(i)
          }}
        >
          <desc id={descId}>{`${labels[idx]}: ${series.map((s) => `${s.label} ${s.points[idx]?.value != null ? formatValue(s.points[idx]!.value!) : 'not available'}`).join(', ')}`}</desc>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} stroke={SERIES.grid} />
              <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums">
                {formatAxis(t)}
              </text>
            </g>
          ))}
          {gaps
            .filter((g) => g.index > 0 && g.index < n)
            .map((g) => {
              const x0 = x(xs[g.index - 1]!)
              const x1 = x(xs[g.index]!)
              return (
                <g key={`gap${g.index}`} data-testid="chart-gap">
                  <rect x={x0} y={M.top} width={Math.max(2, x1 - x0)} height={plotH} fill="#f8fafc" stroke="#cbd5e1" strokeDasharray="3 3" />
                  <text x={(x0 + x1) / 2} y={M.top + 12} textAnchor="middle" className="fill-slate-500 text-[10px]">
                    {g.label}
                  </text>
                </g>
              )
            })}
          {baseline !== undefined && <line x1={M.left} x2={M.left + plotW} y1={y(baseline)} y2={y(baseline)} stroke={SERIES.axis} strokeDasharray="2 3" />}
          <line x1={x(xs[idx]!)} x2={x(xs[idx]!)} y1={M.top} y2={M.top + plotH} stroke={SERIES.axis} strokeWidth={1} />
          {/* Draw the first (primary) series last so it sits on top. */}
          {[...series].reverse().map((s) => (
            <g key={s.key}>
              {s.points.map((p, i) =>
                typeof p.low === 'number' && typeof p.high === 'number' && p.high > p.low ? (
                  <line key={`r${i}`} x1={x(xs[i]!)} x2={x(xs[i]!)} y1={y(p.low)} y2={y(p.high)} stroke={s.color} strokeOpacity={0.45} strokeWidth={3} strokeLinecap="round" />
                ) : null,
              )}
              {s.points.map((p, i) => {
                const prev = s.points[i - 1]
                if (i === 0 || p.value === null || !prev || prev.value === null) return null
                return (
                  <line
                    key={`s${i}`}
                    x1={x(xs[i - 1]!)}
                    y1={y(prev.value)}
                    x2={x(xs[i]!)}
                    y2={y(p.value)}
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeDasharray={s.dashed || p.weak ? '5 4' : undefined}
                  />
                )
              })}
              {s.points.map((p, i) =>
                p.value !== null && (showMarkers || i === idx) ? (
                  <circle
                    key={`p${i}`}
                    cx={x(xs[i]!)}
                    cy={y(p.value)}
                    r={i === idx ? 5 : 3.5}
                    fill={p.weak ? '#fff' : s.color}
                    stroke={p.weak ? s.color : '#fff'}
                    strokeWidth={p.weak ? 2 : 1.5}
                  />
                ) : null,
              )}
            </g>
          ))}
          {axisLabels.map((l, i) =>
            shownLabels.has(i) ? (
              <text key={i} x={x(xs[i]!)} y={height - 6} textAnchor="middle" className="fill-slate-500 text-[11px]">
                {l}
              </text>
            ) : null,
          )}
        </svg>
      </div>
    </figure>
  )
}
