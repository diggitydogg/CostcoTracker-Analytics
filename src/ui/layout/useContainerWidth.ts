import { useCallback, useState } from 'react'

/**
 * The current content width of an element, tracked with ResizeObserver: the
 * web equivalent of reading a view's geometry. Returns null until measured
 * (and where ResizeObserver is unavailable), so callers fall back to their
 * compact presentation.
 *
 * It measures the region itself, not the window or the screen: a pane, a
 * Split View half or a resized window all report the space actually available.
 */
export function useContainerWidth<T extends HTMLElement>(): [(el: T | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null)
  const ref = useCallback((el: T | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const w = Math.floor(el.getBoundingClientRect().width)
      setWidth((prev) => (w > 0 && w !== prev ? w : prev))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}
