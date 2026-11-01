import { useCallback, useState } from 'react'

/**
 * Tracks an element's content width with ResizeObserver so charts are drawn
 * at real pixel size (crisp text, no stretched strokes). Falls back to
 * `fallback` where ResizeObserver is unavailable (e.g. tests).
 */
export function useElementWidth<T extends HTMLElement>(fallback = 720): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(fallback)
  const ref = useCallback(
    (el: T | null) => {
      if (!el || typeof ResizeObserver === 'undefined') return
      const measure = () => {
        const w = Math.floor(el.getBoundingClientRect().width)
        if (w > 0) setWidth(w)
      }
      measure()
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      return () => ro.disconnect()
    },
    [],
  )
  return [ref, width]
}
