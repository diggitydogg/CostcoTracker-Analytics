/**
 * Warehouse / channel analytics.
 *
 * Receipts are grouped by channel (sourceType) and the warehouse string,
 * normalized only for case and whitespace — warehouses are never merged on a
 * guess. Special cases are labelled explicitly:
 * - null warehouse                        → kind "unknown";
 * - the iOS placeholder "Warehouse"       → kind "placeholder" (name missing at sync);
 * - online orders ("Online Order (…)")    → kind "online-fulfillment";
 * - synthetic (test/demo) receipts        → kind "synthetic".
 * Spend is the estimated basket (Σ item line totals) of the group's receipts.
 */
import type { AnalyticsIndex, PurchaseEvent } from './model'
import { ratio, roundCents } from './stats'

export type WarehouseKind = 'store' | 'online-fulfillment' | 'placeholder' | 'unknown' | 'synthetic'

export type WarehouseGroup = {
  key: string
  label: string
  kind: WarehouseKind
  sourceType: PurchaseEvent['sourceType']
  /** Raw strings merged into this group (case/whitespace variants only). */
  variants: string[]
  events: number
  spendCents: number
  averageBasketCents: number | null
  uniqueItems: number
  firstDate: string | null
  lastDate: string | null
  receiptIds: string[]
}

export type ChannelSummary = { events: number; spendCents: number; averageBasketCents: number | null; spendShare: number | null }

export type WarehouseAnalytics = {
  groups: WarehouseGroup[]
  channels: Record<PurchaseEvent['sourceType'], ChannelSummary>
}

export function normalizeWarehouse(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toUpperCase()
}

function classify(e: PurchaseEvent): { kind: WarehouseKind; norm: string } {
  if (e.sourceType === 'synthetic') return { kind: 'synthetic', norm: e.warehouse ? normalizeWarehouse(e.warehouse) : '' }
  if (e.warehouse === null || normalizeWarehouse(e.warehouse) === '') return { kind: 'unknown', norm: '' }
  const norm = normalizeWarehouse(e.warehouse)
  if (e.sourceType === 'online') return { kind: 'online-fulfillment', norm }
  if (norm === 'WAREHOUSE') return { kind: 'placeholder', norm }
  return { kind: 'store', norm }
}

export function computeWarehouses(index: AnalyticsIndex): WarehouseAnalytics {
  const groups = new Map<string, { kind: WarehouseKind; events: PurchaseEvent[]; variants: Map<string, number> }>()
  for (const e of index.events) {
    const { kind, norm } = classify(e)
    const key = `${e.sourceType}|${kind}|${norm}`
    const g = groups.get(key) ?? { kind, events: [], variants: new Map<string, number>() }
    g.events.push(e)
    if (e.warehouse !== null) g.variants.set(e.warehouse, (g.variants.get(e.warehouse) ?? 0) + 1)
    groups.set(key, g)
  }

  const linesByReceipt = new Map<string, Set<string>>()
  for (const l of index.lines) {
    const set = linesByReceipt.get(l.receiptId) ?? new Set<string>()
    set.add(l.itemNumber)
    linesByReceipt.set(l.receiptId, set)
  }

  const out: WarehouseGroup[] = [...groups.entries()].map(([key, g]) => {
    const variants = [...g.variants.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([v]) => v)
    const label =
      g.kind === 'unknown'
        ? 'Unknown warehouse'
        : g.kind === 'placeholder'
          ? 'Unknown warehouse (name not recorded)'
          : g.kind === 'synthetic'
            ? (variants[0] ?? 'Synthetic data')
            : variants[0]!
    const withBasket = g.events.filter((e) => e.basketCents !== null)
    const spend = withBasket.reduce((s, e) => s + e.basketCents!, 0)
    const items = new Set<string>()
    for (const e of g.events) for (const n of linesByReceipt.get(e.id) ?? []) items.add(n)
    const dates = g.events.map((e) => e.date).filter((d): d is string => d !== null).sort()
    return {
      key,
      label,
      kind: g.kind,
      sourceType: g.events[0]!.sourceType,
      variants,
      events: g.events.length,
      spendCents: spend,
      averageBasketCents: roundCents(ratio(spend, withBasket.length)),
      uniqueItems: items.size,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      receiptIds: g.events.map((e) => e.id),
    }
  })
  out.sort((a, b) => b.spendCents - a.spendCents || (a.key < b.key ? -1 : 1))

  const totalSpend = out.reduce((s, g) => s + g.spendCents, 0)
  const channel = (type: PurchaseEvent['sourceType']): ChannelSummary => {
    const events = index.events.filter((e) => e.sourceType === type)
    const withBasket = events.filter((e) => e.basketCents !== null)
    const spend = withBasket.reduce((s, e) => s + e.basketCents!, 0)
    return {
      events: events.length,
      spendCents: spend,
      averageBasketCents: roundCents(ratio(spend, withBasket.length)),
      spendShare: totalSpend > 0 ? ratio(spend, totalSpend) : null,
    }
  }
  return { groups: out, channels: { warehouse: channel('warehouse'), online: channel('online'), synthetic: channel('synthetic') } }
}
