/**
 * CostcoTracker Analytics engine — public API.
 * See docs/ANALYTICS_ENGINE.md for every formula and threshold.
 */
export { buildAnalyticsSnapshot, type AnalyticsOptions, type AnalyticsSnapshot } from './snapshot'
export { DEFAULT_THRESHOLDS, type AnalyticsThresholds } from './config'
export { buildIndex, type AnalyticsIndex, type PurchaseEvent, type PurchaseLine } from './model'
export type { SpendingAnalytics, SpendBucket, MonthlySpend, YearlySpend } from './spending'
export type { TripAnalytics } from './trips'
export type { ItemAnalytics, ItemStats, ItemCohort } from './items'
export { priceHistory, type PriceHistory, type PricePoint } from './prices'
export {
  INFLATION_CONFIDENCE_LEVELS,
  inflationSeries,
  linkConfidence,
  type InflationAnalytics,
  type InflationConfidence,
  type InflationLink,
  type InflationSeries,
} from './inflation'
export type { PurchaseLinkedRate } from './linkage'
export type { ReturnAnalytics } from './returns'
export type { AdjustmentAnalytics } from './adjustments'
export { normalizeWarehouse, type WarehouseAnalytics, type WarehouseGroup } from './warehouses'
export type { CategoryAnalytics, CategorySpend } from './categories/analytics'
export {
  categorize,
  matchRules,
  normalizeDescription,
  parseCategoryOverrides,
  serializeCategoryOverrides,
  tokenize,
  withOverride,
  type CategoryAssignment,
  type CategoryOverride,
  type CategoryOverrides,
  type CategorySuggester,
} from './categories/engine'
export { DEFAULT_RULES, type CategoryRule } from './categories/rules'
export { CATEGORIES, categoryLabel, subcategoryLabel, type CategoryId } from './categories/taxonomy'
export type { DataQuality, DatasetSourceInfo } from './quality'
