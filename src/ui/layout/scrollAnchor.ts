import { useCallback, useLayoutEffect, useRef } from 'react'

type Anchor = { el: Element; top: number }

const viewportHeight = () => document.documentElement.clientHeight

/** Whether an element is inside `region` and at least partly on screen. */
function visibleIn(region: HTMLElement, el: Element | null | undefined): el is Element {
  if (!el || !region.contains(el)) return false
  const r = el.getBoundingClientRect()
  return r.bottom > 0 && r.top < viewportHeight()
}

/**
 * Keeps a region visually still across one layout change that resizes it
 * (opening or closing a split view's secondary pane changes the primary
 * column's width, so its content rewraps and everything below moves).
 *
 * `capture` records an anchor in `region` — the preferred element (the row
 * the person tapped, or the selected row) if it is on screen, else the first
 * element at the top of the visible part of the region — and its position on
 * screen. On the next commit, before paint, the page is scrolled by exactly
 * how far that anchor moved, so it stays where the person was looking. Only
 * the document's scrolling element moves (that is what scrolls the primary
 * content); nothing happens without a capture, and no timers are involved.
 * This is CSS scroll anchoring done deterministically, for browsers (Safari)
 * that do not anchor, or anchor to a different node.
 */
export function useScrollAnchor(): (region: HTMLElement | null, ...preferred: (Element | null | undefined)[]) => void {
  const anchor = useRef<Anchor | null>(null)

  const capture = useCallback((region: HTMLElement | null, ...preferred: (Element | null | undefined)[]) => {
    anchor.current = null
    if (!region) return
    let el: Element | null = preferred.find((p) => visibleIn(region, p)) ?? null
    if (!el) {
      const r = region.getBoundingClientRect()
      const y = Math.max(r.top, 0) + 1
      const hit = y < viewportHeight() ? document.elementFromPoint(r.left + Math.min(24, r.width / 2), y) : null
      el = hit && region.contains(hit) ? hit : null
    }
    if (el) anchor.current = { el, top: el.getBoundingClientRect().top }
  }, [])

  // Runs after every commit; acts only on a pending capture.
  useLayoutEffect(() => {
    const a = anchor.current
    anchor.current = null
    if (!a || !a.el.isConnected) return
    const moved = a.el.getBoundingClientRect().top - a.top
    if (Math.abs(moved) < 1) return
    const scroller = document.scrollingElement ?? document.documentElement
    scroller.scrollTop += moved
  })

  return capture
}
