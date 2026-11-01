import { useEffect, useRef, type ReactNode } from 'react'
import { useDashboard, type Drill } from './context'
import { InflationLinkDetail } from './details/InflationLinkDetail'
import { ItemDetail } from './details/ItemDetail'
import { ReceiptDetail } from './details/ReceiptDetail'
import { RecordsDetail } from './details/RecordsDetail'
import { date } from './format'

/**
 * Side drawer for drill-down (full screen on phones). It is a modal dialog:
 * Escape or the backdrop closes it, focus moves into it and returns to the
 * control that opened it.
 */
export function DrillDrawer({ drill, canGoBack, onBack, onClose }: { drill: Drill; canGoBack: boolean; onBack: () => void; onClose: () => void }) {
  const { s } = useDashboard()
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    return () => opener?.focus?.()
  }, [])
  useEffect(() => {
    closeRef.current?.focus()
    panelRef.current?.scrollTo?.({ top: 0 })
  }, [drill])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  let title: string
  let body: ReactNode
  switch (drill.kind) {
    case 'item':
      title = s.items.byItemNumber.get(drill.itemNumber)?.displayDescription ?? `Item ${drill.itemNumber}`
      body = <ItemDetail itemNumber={drill.itemNumber} />
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
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drill-title"
        className="relative flex h-full w-full max-w-3xl flex-col overflow-y-auto bg-slate-50 shadow-xl"
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          {canGoBack && (
            <button type="button" onClick={onBack} className="rounded-md px-2 py-1 text-sm text-slate-700 hover:bg-slate-100">
              ← Back
            </button>
          )}
          <h2 id="drill-title" className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900">
            {title}
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-100">
            Close
          </button>
        </div>
        <div className="space-y-4 p-4 sm:p-6">{body}</div>
      </div>
    </div>
  )
}
