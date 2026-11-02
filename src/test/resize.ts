import { act } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * Simulates the space available to the UI changing (a resized window, a
 * rotated device, a foldable opening or closing): every element reports
 * `width` CSS pixels, and every ResizeObserver is notified. jsdom has no
 * layout, so this is how tests drive width-dependent presentation.
 *
 * Call before rendering. `resize(px)` changes the width later; `restore()`
 * undoes the stubs.
 */
export function mockAvailableWidth(initial: number) {
  const callbacks = new Set<ResizeObserverCallback>()
  let width = initial
  let geometry: ((el: HTMLElement) => Partial<DOMRect> | null) | null = null
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
        callbacks.add(cb)
      }
      observe() {}
      unobserve() {}
      disconnect() {
        callbacks.delete(this.cb)
      }
    },
  )
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const base = { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() {} }
      return { ...base, ...(geometry?.(this) ?? {}) } as DOMRect
    })
  return {
    resize(next: number) {
      width = next
      act(() => {
        for (const cb of [...callbacks]) cb([], {} as ResizeObserver)
      })
    },
    /** Gives elements a modeled position (jsdom has no layout), e.g. rows that move when a layout reflows. */
    setGeometry(fn: (el: HTMLElement) => Partial<DOMRect> | null) {
      geometry = fn
    },
    restore() {
      rect.mockRestore()
      vi.unstubAllGlobals()
    },
  }
}
