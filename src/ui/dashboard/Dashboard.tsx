import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { buildAnalyticsSnapshot, type DatasetSourceInfo } from '../../analytics'
import type { AnalyticsExportV1 } from '../../domain/export/v1'
import { createOverridesStore, type OverridesStore } from '../../persistence/overridesStore'
import { DashboardContext, type CatalogEditor, type DashboardContextValue, type Drill, type Lookups } from './context'
import { DrillDrawer } from './DrillDrawer'
import { canSplit } from '../layout/tokens'
import { useContainerWidth } from '../layout/useContainerWidth'
import { useInputModalityTracking } from '../layout/inputModality'
import { count, date, todayIso } from './format'
import { CategoriesSection } from './sections/CategoriesSection'
import { InflationSection } from './sections/InflationSection'
import { ItemsSection } from './sections/ItemsSection'
import { OverviewSection } from './sections/OverviewSection'
import { ReturnsAdjustmentsSection } from './sections/ReturnsAdjustmentsSection'
import { WarehousesSection } from './sections/WarehousesSection'
import { useCategoryOverrides } from './useCategoryOverrides'
import type { ProductIdentities, ProductIdentity } from '../../analytics/products/identityProtocol'
import { useSuggestionSession, type BatchCategorySuggester, type BatchIdentifier } from './useSuggestionSession'

export type DashboardTab = 'overview' | 'items' | 'inflation' | 'categories' | 'returns' | 'warehouses'

const TABS: { id: DashboardTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'items', label: 'Items' },
  { id: 'inflation', label: 'Price index' },
  { id: 'categories', label: 'Categories' },
  { id: 'returns', label: 'Returns & adjustments' },
  { id: 'warehouses', label: 'Warehouses' },
]

const unavailableSuggester: BatchCategorySuggester = async () => {
  throw new Error('AI suggestions are not available here.')
}

let defaultStore: OverridesStore | null = null
const getDefaultStore = () => (defaultStore ??= createOverridesStore())

/**
 * The analytics dashboard. Builds exactly ONE snapshot per (dataset, category
 * overrides) and hands it to every section through context, so no widget
 * recomputes analytics on its own.
 *
 * As-of date: every figure uses the engine's default, the latest date in the
 * dataset, so all widgets agree and results are reproducible. Only "N days
 * ago" wording uses today's date, and it is labelled as such.
 */
export function Dashboard({
  data,
  source,
  overridesStore,
  today = todayIso(),
  toolbar,
  initialTab = 'overview',
  suggester,
  identifier,
  productIdentities,
  onIdentities,
  catalog,
}: {
  data: AnalyticsExportV1
  source: DatasetSourceInfo
  overridesStore?: OverridesStore
  today?: string
  toolbar?: ReactNode
  initialTab?: DashboardTab
  /** Cloud mode only: sends Uncategorized items to the AI suggestion endpoint. Omitted in local-file mode. */
  suggester?: BatchCategorySuggester
  /** Cloud mode only: identifies item numbers (cache first, then targeted web search) before AI suggestions. */
  identifier?: BatchIdentifier
  /** Our resolved local product catalog (by item number); rules may match canonical names after receipt text. */
  productIdentities?: ProductIdentities
  /** Receives identities found during a review session. */
  onIdentities?: (found: ProductIdentity[]) => void
  /** Cloud mode only: confirm, edit and remove owner-confirmed product identities. */
  catalog?: CatalogEditor
}) {
  const store = overridesStore ?? getDefaultStore()
  const overrides = useCategoryOverrides(store)
  const s = useMemo(
    () =>
      buildAnalyticsSnapshot(data, { source, categoryOverrides: overrides.overrides, ...(productIdentities ? { productIdentities } : {}) }),
    [data, source, overrides.overrides, productIdentities],
  )
  const lookups = useMemo<Lookups>(() => {
    const warehouseLabelByReceipt = new Map<string, string>()
    for (const g of s.warehouses.groups) for (const id of g.receiptIds) warehouseLabelByReceipt.set(id, g.label)
    return {
      lineById: new Map(s.index.lines.map((l) => [l.id, l])),
      returnById: new Map(s.index.returns.map((r) => [r.id, r])),
      adjustmentById: new Map(s.index.adjustments.map((a) => [a.id, a])),
      warehouseLabelByReceipt,
    }
  }, [s])

  const session = useSuggestionSession(suggester ?? unavailableSuggester, identifier, onIdentities)
  const ai = suggester ? session : null

  const [tab, setTab] = useState<DashboardTab>(initialTab)
  const [stack, setStack] = useState<Drill[]>([])
  // Choosing something in the dashboard shows it (replacing what was shown, like selecting another
  // row of a split view's primary list); drilling further inside the detail pushes, so Back works.
  // The control that opened the current detail (the selected row), updated on every selection, so
  // closing returns to where the person is now, not to the row that first opened the detail.
  const opener = useRef<HTMLElement | null>(null)
  const show = useCallback((d: Drill) => {
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    setStack([d])
  }, [])
  const getOpener = useCallback(() => (opener.current?.isConnected ? opener.current : null), [])
  useInputModalityTracking()
  const push = useCallback((d: Drill) => setStack((st) => [...st, d]), [])
  const selected = stack.length > 0 ? stack[stack.length - 1]! : null
  // Layout from the space this dashboard actually has (not the device or orientation):
  // with room for two legible panes the detail docks beside the dashboard; otherwise it is a sheet.
  const [measure, width] = useContainerWidth<HTMLDivElement>()
  const split = canSplit(width) && selected !== null
  const ctx = useMemo<DashboardContextValue>(
    () => ({ s, lookups, open: show, selected, overrides, today, ai, catalog: catalog ?? null }),
    [s, lookups, show, selected, overrides, today, ai, catalog],
  )
  const detailCtx = useMemo<DashboardContextValue>(() => ({ ...ctx, open: push }), [ctx, push])

  const q = s.quality
  const empty = s.trips.eventCount === 0 && s.index.returns.length === 0 && s.index.adjustments.length === 0

  return (
    <DashboardContext.Provider value={ctx}>
      {/* Same element tree in both layouts, so nothing remounts (search, filters, open forms survive). */}
      <div
        ref={measure}
        data-testid="dashboard-layout"
        data-layout={split ? 'split' : 'single'}
        className={split ? 'grid grid-cols-[minmax(0,1fr)_var(--detail-pane-width)] items-start gap-4' : ''}
      >
      <div data-testid="dashboard" className="@container min-w-0 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">Your Costco spending</h2>
            <p className="mt-0.5 text-sm text-slate-600" data-testid="data-range">
              {q.firstDate && q.lastDate
                ? `${date(q.firstDate)} – ${date(q.lastDate)} · ${count(s.trips.eventCount)} purchases · figures as of ${date(s.asOf)}`
                : 'No dated purchases yet'}
              <span className="text-slate-400"> · </span>
              Pre-tax merchandise totals
            </p>
          </div>
          {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}
        </div>

        <nav aria-label="Dashboard sections" className="-mx-[var(--page-gutter)] overflow-x-auto px-[var(--page-gutter)] @regular:mx-0 @regular:px-0">
          <ul className="flex min-w-max gap-1 border-b border-slate-200">
            {TABS.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  aria-current={tab === t.id ? 'page' : undefined}
                  onClick={() => setTab(t.id)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? 'border-sky-700 text-slate-900' : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'}`}
                >
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {empty ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-600">
            There is no purchase data yet. Sync from CostcoTracker on your iPhone or import an export file, then come back here.
          </p>
        ) : (
          <div>
            {tab === 'overview' && <OverviewSection onShowTab={setTab} />}
            {tab === 'items' && <ItemsSection />}
            {tab === 'inflation' && <InflationSection />}
            {tab === 'categories' && <CategoriesSection />}
            {tab === 'returns' && <ReturnsAdjustmentsSection />}
            {tab === 'warehouses' && <WarehousesSection />}
          </div>
        )}
      </div>
      {selected && (
        <DashboardContext.Provider value={detailCtx}>
          <DrillDrawer
            drill={selected}
            canGoBack={stack.length > 1}
            onBack={() => setStack((st) => st.slice(0, -1))}
            onClose={() => setStack([])}
            presentation={split ? 'pane' : 'sheet'}
            getOpener={getOpener}
          />
        </DashboardContext.Provider>
      )}
      </div>
    </DashboardContext.Provider>
  )
}
