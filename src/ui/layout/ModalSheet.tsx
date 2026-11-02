import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { focusWithoutScrolling } from './inputModality'

/**
 * A modal sheet for a blocking task (choosing and analyzing a photo, for
 * example): Apple's sheet guidance — a focused task the person completes or
 * cancels before returning. It is modal at every width (task semantics, not
 * available space), comes in from the trailing edge like the detail sheet,
 * and is rendered into <body> so it never sits inside the dashboard's layout
 * (opening it cannot reflow or scroll the list underneath).
 *
 * Focus (shared rules from PR #9): Close is focused on open and focus returns
 * to the control that opened it on close, both without scrolling the page.
 * Escape and the scrim close it.
 */
export function ModalSheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    focusWithoutScrolling(closeRef.current)
    return () => {
      if (opener?.isConnected) focusWithoutScrolling(opener)
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="safe-top safe-bottom fixed inset-0 z-50 flex justify-end" data-testid="modal-sheet">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-sheet flex-col overflow-y-auto overscroll-contain bg-slate-50 shadow-xl"
      >
        <div className="page-gutter sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white py-3">
          <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold break-words text-slate-900">
            {title}
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-100">
            Close
          </button>
        </div>
        <div className="page-gutter @container flex-1 space-y-4 py-4">{children}</div>
        {footer && <div className="page-gutter sticky bottom-0 border-t border-slate-200 bg-white py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
