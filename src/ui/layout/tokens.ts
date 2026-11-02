/**
 * Adaptive layout tokens, in rem. These mirror the `--container-*` values in
 * src/index.css (a test keeps both in sync), so CSS container queries and the
 * few JS layout decisions use exactly the same widths.
 *
 * Apple's guidance: decide layout from the space actually available, not
 * from device type or orientation. Every value here is compared with the
 * width of a container (a region of the page), never with a device or screen.
 */
export const LAYOUT_REM = {
  pair: 24,
  readable: 42,
  regular: 44,
  sheet: 48,
  wide: 60,
  content: 64,
  /** = SPLIT_PARTS: detail pane minimum + gap + primary minimum. */
  split: 52,
  spacious: 76,
  panoramic: 92,
  page: 100,
} as const

export type LayoutToken = keyof typeof LAYOUT_REM

/**
 * How the split threshold is derived (rem): the docked detail pane never gets
 * narrower than 22rem (--detail-pane-width), the gap is 1rem, and the primary
 * column must keep at least 29rem (464px), more than the widest compact-width
 * iPhone column, so the dashboard is never more cramped than on a phone.
 */
export const SPLIT_PARTS = { detailPaneMin: 22, gap: 1, primaryMin: 29 } as const

/** The CSS reference pixel per rem used for JS comparisons (the root size never changes in layout code). */
const remPx = (): number => {
  if (typeof window === 'undefined' || typeof getComputedStyle === 'undefined') return 16
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(size) && size > 0 ? size : 16
}

export const tokenPx = (token: LayoutToken): number => LAYOUT_REM[token] * remPx()

/** Apple's horizontal size classes, derived from a region's available width. */
export type WidthClass = 'compact' | 'regular'

export const widthClassOf = (widthPx: number | null): WidthClass => (widthPx !== null && widthPx >= tokenPx('regular') ? 'regular' : 'compact')

/**
 * Whether a region has room for a primary list and a detail pane side by side
 * (a split view). Apple: prefer split views in a regular environment, and only
 * where both panes stay legible without wrapping or truncation.
 */
export const canSplit = (widthPx: number | null): boolean => widthPx !== null && widthPx >= tokenPx('split')
