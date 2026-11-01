import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { SERIES } from './palette'
import { labelStride, linear, niceTicks } from './scale'
import { useElementWidth } from './useElementWidth'

export type ColumnSeries = {
  key: string
  label: string
  color: string
  values: readonly number[]
  /** "down" series are drawn below the zero line (e.g. refunds and adjustments). */
  direction?: 'up' | 'down'
}

export type LineOverlay = { key: string; label: string; color: string; values: readonly number[] }

type Props = {
  title: string
  /** Full label of each column, used in the readout. */
  labels: readonly string[]
  /** Axis label of each column. */
  axisLabels: readonly string[]
  series: readonly ColumnSeries[]
  line?: LineOverlay | null
  formatValue: (v: number) => string
  formatAxis: (v: number) => string
  /** Called when a column is opened (second click/tap, Enter, or the readout button). */
  onOpen?: (index: number) => void
  openLabel?: (index: number) => string
  height?: number
  initialIndex?: number
  footer?: (index: number) => ReactNode
}

const M = { top: 8, right: 8, bottom: 22, left: 52 }

/**
 * Stacked column chart with an optional line overlay, drawn as plain SVG.
 * Hover, tap or arrow keys select a column; the readout above the plot shows
 * every series' exact value for it, so values never depend on the tooltip.
 */
export function ColumnChart({
  title,
  labels,
  axisLabels,
  series,
  line,
  formatValue,
  formatAxis,
  onOpen,
  openLabel,
  height = 240,
  initialIndex,
  footer,
}: Props) {
  const n = labels.length
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [active, setActive] = useState<number>(() => Math.max(0, Math.min(n - 1, initialIndex ?? n - 1)))
  const idx = Math.max(0, Math.min(n - 1, active))
  const descId = useId()

  if (n === 0) {
    return <p className="rounded-md border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-600">No dated data to chart.</p>
  }

  const up = series.filter((s) => s.direction !== 'down')
  const down = series.filter((s) => s.direction === 'down')
  const sumAt = (list: readonly ColumnSeries[], i: number) => list.reduce((t, s) => t + Math.max(0, s.values[i] ?? 0), 0)
  let hi = 0
  let lo = 0
  for (let i = 0; i < n; i++) {
    hi = Math.max(hi, sumAt(up, i), line?.values[i] ?? 0)
    lo = Math.min(lo, -sumAt(down, i), line?.values[i] ?? 0)
  }
  const ticks = niceTicks(lo, hi === lo ? lo + 100 : hi, 4)
  const yMin = Math.min(ticks[0]!, 0)
  const yMax = Math.max(ticks[ticks.length - 1]!, 0)
  const plotW = Math.max(40, width - M.left - M.right)
  const plotH = height - M.top - M.bottom
  const y = linear(yMin, yMax, M.top + plotH, M.top)
  const colW = plotW / n
  const barW = Math.max(1, Math.min(28, colW * 0.68))
  const x = (i: number) => M.left + colW * i + colW / 2
  const stride = labelStride(n, plotW, 52)
  const zero = y(0)

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

  const stack = (list: readonly ColumnSeries[], i: number, sign: 1 | -1) => {
    let base = 0
    return list.map((s) => {
      const v = Math.max(0, s.values[i] ?? 0)
      const y0 = y(base * sign)
      base += v
      const y1 = y(base * sign)
      const top = Math.min(y0, y1)
      const h = Math.abs(y1 - y0)
      // 1px surface gap between stacked segments when there is room.
      const gap = h > 3 ? 1 : 0
      return v > 0 ? (
        <rect key={s.key} x={x(i) - barW / 2} y={top + (sign === 1 ? gap : 0)} width={barW} height={Math.max(0.5, h - gap)} rx={Math.min(2, barW / 4)} fill={s.color} />
      ) : null
    })
  }

  const linePath =
    line && n > 1
      ? line.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
      : null

  return (
    <figure className="space-y-2">
      <Legend items={[...series.map((s) => ({ label: s.label, color: s.color, kind: 'box' as const })), ...(line ? [{ label: line.label, color: line.color, kind: 'line' as const }] : [])]} />
      <div aria-live="polite" className="flex min-h-12 flex-wrap items-end justify-between gap-x-4 gap-y-1 rounded-md bg-slate-50 px-3 py-2 text-sm" data-testid="chart-readout">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500">{labels[idx]}</p>
          <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
            {[...series, ...(line ? [line] : [])].map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ backgroundColor: s.color }} />
                <dt className="text-slate-600">{s.label}</dt>
                <dd className="font-semibold tabular-nums text-slate-900">{formatValue(s.values[idx] ?? 0)}</dd>
              </div>
            ))}
          </dl>
          {footer?.(idx)}
        </div>
        {onOpen && (
          <button type="button" onClick={() => onOpen(idx)} className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100">
            {openLabel ? openLabel(idx) : 'View records'}
          </button>
        )}
      </div>
      <div ref={ref} className="w-full">
        <svg
          role="group"
          aria-label={`${title}. Use left and right arrow keys to move between columns${onOpen ? ', Enter to open the records' : ''}.`}
          aria-describedby={descId}
          tabIndex={0}
          onKeyDown={onKey}
          width={width}
          height={height}
          className="block touch-pan-y select-none rounded focus-visible:outline-2 focus-visible:outline-sky-600"
        >
          <desc id={descId}>{`${labels[idx]}: ${series.map((s) => `${s.label} ${formatValue(s.values[idx] ?? 0)}`).join(', ')}`}</desc>
          <rect x={x(idx) - colW / 2} y={M.top} width={colW} height={plotH} fill={SERIES.highlight} />
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? SERIES.axis : SERIES.grid} strokeWidth={1} />
              <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums">
                {formatAxis(t)}
              </text>
            </g>
          ))}
          {labels.map((_, i) => (
            <g key={i}>
              {stack(up, i, 1)}
              {stack(down, i, -1)}
            </g>
          ))}
          {linePath && <path d={linePath} fill="none" stroke={line!.color} strokeWidth={2} strokeLinejoin="round" />}
          {line && <circle cx={x(idx)} cy={y(line.values[idx] ?? 0)} r={4} fill={line.color} stroke="#fff" strokeWidth={2} />}
          {axisLabels.map((l, i) =>
            (n - 1 - i) % stride === 0 ? (
              <text key={i} x={x(i)} y={height - 6} textAnchor="middle" className="fill-slate-500 text-[11px]">
                {l}
              </text>
            ) : null,
          )}
          <line x1={M.left} x2={M.left + plotW} y1={zero} y2={zero} stroke={SERIES.axis} />
          {labels.map((_, i) => (
            <rect
              key={i}
              data-testid="chart-hit"
              x={M.left + colW * i}
              y={M.top}
              width={colW}
              height={plotH}
              fill="transparent"
              onPointerEnter={(e) => {
                if (e.pointerType === 'mouse') select(i)
              }}
              onClick={() => {
                if (i === idx && onOpen) onOpen(i)
                else select(i)
              }}
            />
          ))}
        </svg>
      </div>
    </figure>
  )
}

export function Legend({ items }: { items: { label: string; color: string; kind: 'box' | 'line' | 'dashed' | 'dot' }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={i.kind === 'box' ? 'inline-block h-2.5 w-2.5 rounded-sm' : i.kind === 'dot' ? 'inline-block h-2 w-2 rounded-full' : 'inline-block h-0 w-4 border-t-2'}
            style={i.kind === 'box' || i.kind === 'dot' ? { backgroundColor: i.color } : { borderColor: i.color, borderTopStyle: i.kind === 'dashed' ? 'dashed' : 'solid' }}
          />
          {i.label}
        </li>
      ))}
    </ul>
  )
}
