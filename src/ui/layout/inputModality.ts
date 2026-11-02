import { useEffect } from 'react'

/**
 * Whether the person's most recent interaction was with a keyboard or a
 * pointer (touch, pen, mouse). A docked detail pane uses it to decide focus:
 * someone selecting a row by touch or mouse keeps their place in the list,
 * while a keyboard user is taken into the detail they asked for (the same
 * heuristic browsers use for :focus-visible).
 */
export type InputModality = 'keyboard' | 'pointer'

let last: InputModality = 'pointer'
let lastPointerTarget: Element | null = null
let users = 0
const onKey = (e: KeyboardEvent) => {
  if (!e.metaKey && !e.ctrlKey && !e.altKey) last = 'keyboard'
}
const onPointer = (e: PointerEvent) => {
  last = 'pointer'
  lastPointerTarget = e.target instanceof Element ? e.target : null
}

export const lastInputModality = (): InputModality => last

/** The element the most recent pointer interaction started on (Safari does not focus tapped buttons, so focus can't tell). */
export const lastPointerDownTarget = (): Element | null => (lastPointerTarget?.isConnected ? lastPointerTarget : null)

/** Tracks input modality while any component using it is mounted (capture phase, before handlers run). */
export function useInputModalityTracking(): void {
  useEffect(() => {
    if (users++ === 0) {
      document.addEventListener('keydown', onKey, true)
      document.addEventListener('pointerdown', onPointer, true)
    }
    return () => {
      if (--users === 0) {
        document.removeEventListener('keydown', onKey, true)
        document.removeEventListener('pointerdown', onPointer, true)
        last = 'pointer'
        lastPointerTarget = null
      }
    }
  }, [])
}

/** Moves focus without scrolling the document to reveal the element (Safari and Chromium honor preventScroll). */
export function focusWithoutScrolling(el: HTMLElement | null | undefined): void {
  el?.focus?.({ preventScroll: true })
}
