/**
 * Purchase linkage of returns and price adjustments.
 *
 * A true (causal) return rate or adjustment savings rate needs every return or
 * adjustment to be tied to the specific purchase it came from. Export V1 can
 * carry that link in `sourcePurchaseId`, but the iOS exporter currently always
 * leaves it null. Without it, a return in this dataset may be for a purchase
 * made before the dataset begins, so returns ÷ purchases is only a descriptive
 * ratio over the observed data, not a return rate.
 *
 * A linked rate is reported as available only when EVERY record links to a
 * purchase present in the data; partial linkage would mix linked and unlinked
 * records and is reported as unavailable with the counts.
 */
import type { AnalyticsIndex } from './model'
import { ratio } from './stats'

export type PurchaseLinkedRate =
  | { available: false; linkedRecords: number; unlinkedRecords: number; reason: string }
  | {
      available: true
      linkedRecords: number
      /** Σ linked amounts ÷ Σ spend of the linked purchases' baskets. */
      rate: number | null
      linkedPurchaseIds: string[]
    }

export function purchaseLinkedRate(
  records: readonly { sourcePurchaseId?: string | null | undefined; amount: number }[],
  index: AnalyticsIndex,
  noun: 'return' | 'price adjustment',
): PurchaseLinkedRate {
  const plural = `${noun}s`
  const linked = records.filter((r) => r.sourcePurchaseId != null && index.eventsById.has(r.sourcePurchaseId))
  const unlinked = records.length - linked.length
  if (records.length === 0) {
    return { available: false, linkedRecords: 0, unlinkedRecords: 0, reason: `No ${plural} are recorded.` }
  }
  if (linked.length === 0) {
    return {
      available: false,
      linkedRecords: 0,
      unlinkedRecords: unlinked,
      reason: `No ${noun} is linked to the purchase it came from (sourcePurchaseId is empty), so a purchase-linked rate cannot be calculated. Observed ratios compare ${plural} with purchases inside this dataset only.`,
    }
  }
  if (unlinked > 0) {
    return {
      available: false,
      linkedRecords: linked.length,
      unlinkedRecords: unlinked,
      reason: `Only ${linked.length} of ${records.length} ${plural} are linked to a purchase in this data, so a purchase-linked rate would be incomplete.`,
    }
  }
  const purchaseIds = [...new Set(linked.map((r) => r.sourcePurchaseId!))].sort()
  const purchased = purchaseIds.reduce((s, id) => s + (index.eventsById.get(id)!.basketCents ?? 0), 0)
  return {
    available: true,
    linkedRecords: linked.length,
    rate: purchased > 0 ? ratio(linked.reduce((s, r) => s + r.amount, 0), purchased) : null,
    linkedPurchaseIds: purchaseIds,
  }
}
