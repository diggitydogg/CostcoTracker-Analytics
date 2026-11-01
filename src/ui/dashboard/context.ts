import { createContext, useContext } from 'react'
import type { AnalyticsSnapshot, CategoryOverride, CategoryOverrides, PurchaseLine } from '../../analytics'
import type { PriceAdjustment, Return } from '../../domain/export/v1'

/** What the drill-down drawer can show. Everything is addressed by opaque IDs. */
export type Drill =
  | { kind: 'item'; itemNumber: string }
  | { kind: 'receipt'; id: string }
  | {
      kind: 'records'
      title: string
      description?: string
      receiptIds?: readonly string[]
      returnIds?: readonly string[]
      adjustmentIds?: readonly string[]
    }
  | { kind: 'inflation-link'; granularity: 'year' | 'month'; index: number }

export type Lookups = {
  lineById: Map<string, PurchaseLine>
  returnById: Map<string, Return>
  adjustmentById: Map<string, PriceAdjustment>
  /** Display label of each receipt's warehouse group (placeholder/unknown handled by the engine). */
  warehouseLabelByReceipt: Map<string, string>
}

export type OverridesState = {
  overrides: CategoryOverrides
  setOverride: (itemNumber: string, value: CategoryOverride | null) => void
  /** Whether overrides are saved on this device (false: kept for this tab only). */
  persistent: boolean
  error: string | null
}

export type DashboardContextValue = {
  s: AnalyticsSnapshot
  lookups: Lookups
  open: (d: Drill) => void
  overrides: OverridesState
  /** Today's date (YYYY-MM-DD), used only for "days ago" wording. */
  today: string
}

export const DashboardContext = createContext<DashboardContextValue | null>(null)

export function useDashboard(): DashboardContextValue {
  const v = useContext(DashboardContext)
  if (!v) throw new Error('useDashboard must be used inside <Dashboard>')
  return v
}
