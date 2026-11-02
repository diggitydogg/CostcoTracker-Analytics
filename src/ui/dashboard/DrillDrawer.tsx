import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { focusWithoutScrolling, lastInputModality } from '../layout/inputModality'
import { useDashboard, type Drill } from './context'
import { InflationLinkDetail } from './details/InflationLinkDetail'
import { ItemDetail } from './details/ItemDetail'
import { ReceiptDetail } from './details/ReceiptDetail'
import { RecordsDetail } from './details/RecordsDetail'
import { date } from './format'

/**
 * How a drill-down is presented, chosen from the space available (never from
 * the device or orientation):
 * - `sheet`: a modal side sheet over the dashboard (full width in compact
 *   width, bounded to the sheet width otherwise). Escape or the backdrop
 *   closes it.
 * - `pane`: the secondary pane of a split view, docked beside the dashboard
 *   so the list stays visible and usable (Apple: show an additional level of
 *   hierarchy when there is room). Not modal.
 */
export type DetailPresentation = 'sheet' | 'pane'

/**
 * Drill-down detail. Both presentations render the same element tree, so
 * switching between them (rotation, resizing, opening/closing a foldable)
 * keeps everything inside: open forms and their unsaved input survive.
 *
 * Focus follows the presentation's semantics, and never scrolls the page
 * (`preventScroll`):
 * - sheet (modal dialog): focus moves to Close when a detail opens or when
 *   the detail becomes modal; on close it returns to the control that opened
 *   the current detail.
 * - pane (persistent secondary pane of a split view): selecting another row
 *   by touch or pointer leaves focus — and the person's place in the list —
 *   where it is; a keyboard selection moves focus into the pane. On close,
 *   focus only moves if it was inside the pane (a keyboard user closing it),
 *   and then to the row of the *current* selection, never to the row that
 *   first opened the pane.
 * The pane's own scroll resets to the top for each new detail.
 */
export function DrillDrawer({
  drill,
  canGoBack,
  onBack,
  onClose,
  presentation = 'sheet',
  getOpener = () => null,
}: {
  drill: Drill
  canGoBack: boolean
  onBack: () => void
  onClose: () => void
  presentation?: DetailPresentation
  /** The control that opened the current detail (the selected row), for returning focus. */
  getOpener?: () => HTMLElement | null
}) {
  const pane = presentation === 'pane'
  // A full-width sheet meets the screen edges, so it keeps clear of the safe area; a docked pane does not.
  const inset = pane ? 'px-4' : 'page-gutter'
  const { s } = useDashboard()
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // The latest presentation, for effects and handlers that must not re-run when it changes (synced before they run).
  const presentationRef = useRef(presentation)
  useLayoutEffect(() => {
    presentationRef.current = presentation
  }, [presentation])

  // A new detail: its own scroll starts at the top. Focus moves in for a sheet, or for a keyboard selection in a pane.
  useEffect(() => {
    panelRef.current?.scrollTo?.({ top: 0 })
    if (presentationRef.current === 'sheet' || lastInputModality() === 'keyboard') focusWithoutScrolling(closeRef.current)
  }, [drill])
  // Becoming modal (a pane turns into a sheet when space shrinks): focus belongs inside the dialog.
  useEffect(() => {
    if (!pane && !panelRef.current?.contains(document.activeElement)) focusWithoutScrolling(closeRef.current)
  }, [pane])

  const close = useCallback(() => {
    const focusInside = panelRef.current?.contains(document.activeElement) ?? false
    // Sheet: dialog semantics, return focus to the opener. Pane: only rescue focus that would be lost with the pane.
    if (presentationRef.current === 'sheet' || focusInside) focusWithoutScrolling(getOpener())
    onClose()
  }, [onClose, getOpener])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A modal sheet closes on Escape from anywhere; a docked pane only when focus is inside it.
      if (!pane || panelRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close, pane])

  let title: string
  let body: ReactNode
  switch (drill.kind) {
    case 'item':
      title = s.items.byItemNumber.get(drill.itemNumber)?.displayDescription ?? `Item ${drill.itemNumber}`
      body = <ItemDetail itemNumber={drill.itemNumber} {...(drill.match ? { match: drill.match } : {})} />
      break
    case 'receipt': {
      const e = s.index.eventsById.get(drill.id)
      title = e ? `${e.sourceType === 'online' ? 'Online order' : 'Purchase'} · ${date(e.date)}` : 'Purchase'
      body = <ReceiptDetail id={drill.id} />
      break
    }
    case 'records':
      title = drill.title
      body = <RecordsDetail drill={drill} />
      break
    case 'inflation-link': {
      const series = drill.granularity === 'year' ? s.inflation.yearly : s.inflation.monthly
      const link = series.links[drill.index]
      title = link ? `Price change ${link.from} → ${link.to}` : 'Price change'
      body = <InflationLinkDetail granularity={drill.granularity} index={drill.index} />
      break
    }
  }

  return (
    <div
      data-testid="detail"
      data-presentation={presentation}
      className={pane ? 'sticky top-4 min-w-0 self-start' : 'safe-top safe-bottom fixed inset-0 z-40 flex justify-end'}
    >
      {pane ? null : <div className="absolute inset-0 bg-slate-900/30" onClick={close} aria-hidden />}
      <div
        ref={panelRef}
        role={pane ? 'region' : 'dialog'}
        aria-modal={pane ? undefined : 'true'}
        aria-labelledby="drill-title"
        className={
          pane
            ? 'flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-slate-50 shadow-sm'
            : 'relative flex h-full w-full max-w-sheet flex-col overflow-y-auto overscroll-contain bg-slate-50 shadow-xl'
        }
      >
        <div className={`sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white py-3 ${inset}`}>
          {canGoBack && (
            <button type="button" onClick={onBack} className="min-h-11 rounded-md px-2 py-1 text-sm text-slate-700 hover:bg-slate-100">
              ← Back
            </button>
          )}
          <h2 id="drill-title" className="line-clamp-2 min-w-0 flex-1 text-base font-semibold break-words text-slate-900">
            {title}
          </h2>
          <button ref={closeRef} type="button" onClick={close} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-100">
            Close
          </button>
        </div>
        {/* A container: the detail's grids adapt to the pane or sheet width, not to the window. */}
        <div className={`@container space-y-4 py-4 ${inset}`}>{body}</div>
      </div>
    </div>
  )
}
