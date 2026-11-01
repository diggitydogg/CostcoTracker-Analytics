import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { buildAnalyticsSnapshot, type DatasetSourceInfo } from '../../analytics'
import type { AnalyticsExportV1 } from '../../domain/export/v1'
import { createOverridesStore, type OverridesStore } from '../../persistence/overridesStore'
import { DashboardContext, type DashboardContextValue, type Drill, type Lookups } from './context'
import { DrillDrawer } from './DrillDrawer'
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
  const open = useCallback((d: Drill) => setStack((st) => [...st, d]), [])
  const ctx = useMemo<DashboardContextValue>(
    () => ({ s, lookups, open, overrides, today, ai }),
    [s, lookups, open, overrides, today, ai],
  )

  const q = s.quality
  const empty = s.trips.eventCount === 0 && s.index.returns.length === 0 && s.index.adjustments.length === 0

  return (
    <DashboardContext.Provider value={ctx}>
      <div data-testid="dashboard" className="space-y-4">
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

        <nav aria-label="Dashboard sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
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
      {stack.length > 0 && (
        <DrillDrawer
          drill={stack[stack.length - 1]!}
          canGoBack={stack.length > 1}
          onBack={() => setStack((st) => st.slice(0, -1))}
          onClose={() => setStack([])}
        />
      )}
    </DashboardContext.Provider>
  )
}
