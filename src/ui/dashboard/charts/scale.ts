/** Small scale helpers for the hand-drawn SVG charts. */

/** "Nice" tick values covering [min, max] with about `target` steps. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0]
  if (min === max) {
    if (min === 0) return [0, 1]
    const pad = Math.abs(min) * 0.1
    min -= pad
    max += pad
  }
  const raw = (max - min) / target
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step)
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step)
  return ticks
}

export function linear(d0: number, d1: number, r0: number, r1: number) {
  const span = d1 - d0 || 1
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0)
}

/** Show every k-th label so labels never collide. */
export function labelStride(count: number, width: number, minSpacing: number): number {
  if (count <= 0) return 1
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / minSpacing))))
}
