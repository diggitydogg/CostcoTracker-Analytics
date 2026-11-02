import { createContext, useContext } from 'react'
import type { AnalyticsSnapshot, CategoryOverride, CategoryOverrides, PurchaseLine } from '../../analytics'
import type { PriceAdjustment, Return } from '../../domain/export/v1'
import type { SuggestionSession } from './useSuggestionSession'

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

/** The owner's own fields for a confirmed product identity. */
export type IdentityFields = { canonicalName: string; brand: string | null; productType: string | null }

/**
 * Owner-confirmed catalog identities (cloud mode). Each call saves to the
 * owner's own catalog and updates the dashboard; failures reject with a
 * plain-language Error message.
 */
export type CatalogEditor = {
  confirm: (itemNumber: string, receiptDescription: string, fields: IdentityFields) => Promise<void>
  update: (itemNumber: string, fields: IdentityFields) => Promise<void>
  remove: (itemNumber: string) => Promise<void>
}

export type DashboardContextValue = {
  s: AnalyticsSnapshot
  lookups: Lookups
  open: (d: Drill) => void
  overrides: OverridesState
  /** Today's date (YYYY-MM-DD), used only for "days ago" wording. */
  today: string
  /** Optional AI category suggestions (cloud mode only); null when unavailable. */
  ai: SuggestionSession | null
  /** Owner-confirmed identities (cloud mode only); null when unavailable. */
  catalog: CatalogEditor | null
}

export const DashboardContext = createContext<DashboardContextValue | null>(null)

export function useDashboard(): DashboardContextValue {
  const v = useContext(DashboardContext)
  if (!v) throw new Error('useDashboard must be used inside <Dashboard>')
  return v
}
