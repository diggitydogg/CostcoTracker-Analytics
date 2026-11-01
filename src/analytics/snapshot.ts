/**
 * One coherent analytics snapshot of an Analytics Export V1 dataset.
 * The UI asks for this once (memoized on the dataset) instead of recomputing
 * figures independently. Pure: no I/O, no clock unless `asOf` is omitted (then
 * the latest date in the data is used, so results are deterministic).
 */
import type { AnalyticsExportV1 } from '../domain/export/v1'
import { computeAdjustments, type AdjustmentAnalytics } from './adjustments'
import { computeCategories, type CategoryAnalytics } from './categories/analytics'
import type { CategoryOverrides } from './categories/engine'
import type { CategoryRule } from './categories/rules'
import { DEFAULT_THRESHOLDS, type AnalyticsThresholds } from './config'
import { computeInflation, type InflationAnalytics } from './inflation'
import { computeItems, type ItemAnalytics } from './items'
import type { ProductIdentities } from './products/identityProtocol'
import { buildIndex, type AnalyticsIndex } from './model'
import { computeQuality, type DataQuality, type DatasetSourceInfo } from './quality'
import { computeReturns, type ReturnAnalytics } from './returns'
import { computeSpending, type SpendingAnalytics } from './spending'
import { computeTrips, type TripAnalytics } from './trips'
import { computeWarehouses, type WarehouseAnalytics } from './warehouses'

export type AnalyticsOptions = {
  /** Reference date (YYYY-MM-DD) for "days since" and rolling windows. Defaults to the latest date in the data. */
  asOf?: string | null
  categoryOverrides?: CategoryOverrides
  categoryRules?: readonly CategoryRule[]
  /** Our resolved local product catalog, keyed by item number. Rules may match canonical names after receipt descriptions. */
  productIdentities?: ProductIdentities
  thresholds?: Partial<AnalyticsThresholds>
  source?: DatasetSourceInfo
}

export type AnalyticsSnapshot = {
  asOf: string | null
  currency: string
  thresholds: AnalyticsThresholds
  spending: SpendingAnalytics
  trips: TripAnalytics
  items: ItemAnalytics
  inflation: InflationAnalytics
  returns: ReturnAnalytics
  adjustments: AdjustmentAnalytics
  warehouses: WarehouseAnalytics
  categories: CategoryAnalytics
  quality: DataQuality
  index: AnalyticsIndex
}

export function buildAnalyticsSnapshot(data: AnalyticsExportV1, options: AnalyticsOptions = {}): AnalyticsSnapshot {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds }
  const index = buildIndex(data, options.asOf)
  const spending = computeSpending(index)
  const gross = spending.lifetime.grossCents
  const trips = computeTrips(index, thresholds.topN)
  const items = computeItems(index, thresholds, options.categoryOverrides ?? {}, options.categoryRules, options.productIdentities)
  const inflation = computeInflation(index, thresholds)
  const returns = computeReturns(index, items, gross, thresholds.topN)
  const adjustments = computeAdjustments(index, items, gross, thresholds.topN)
  const warehouses = computeWarehouses(index)
  const categories = computeCategories(items, gross, thresholds.topN)
  const quality = computeQuality(index, gross, categories, returns, adjustments, inflation, warehouses, options.source ?? null)
  return {
    asOf: index.asOf,
    currency: data.currency,
    thresholds,
    spending,
    trips,
    items,
    inflation,
    returns,
    adjustments,
    warehouses,
    categories,
    quality,
    index,
  }
}
