/**
 * Synthetic dataset builder for analytics tests. Every dataset is validated by
 * the real Export V1 importer, so tests can only use contract-valid data.
 * All values are synthetic.
 */
import type { AnalyticsExportV1 } from '../../domain/export/v1'
import { importExportValue } from '../../domain/import/importExport'

type Source = 'warehouse' | 'online' | 'synthetic'

export class DatasetBuilder {
  private receipts: Record<string, unknown>[] = []
  private items: Record<string, unknown>[] = []
  private returns: Record<string, unknown>[] = []
  private adjustments: Record<string, unknown>[] = []
  private n = 0

  private id(prefix: string) {
    this.n += 1
    return `${prefix}_${String(this.n).padStart(5, '0')}`
  }

  receipt(opts: { date: string | null; source?: Source; warehouse?: string | null; whse?: boolean; id?: string }): string {
    const source = opts.source ?? 'warehouse'
    const id = opts.id ?? this.id('r')
    this.receipts.push({
      id,
      sourceType: source,
      identifierKind:
        source === 'online' ? 'onlineOrderKey' : source === 'synthetic' ? 'synthetic' : opts.whse ? 'synthesizedWarehouseKey' : 'transactionBarcode',
      purchaseDate: opts.date,
      warehouse: opts.warehouse === undefined ? (source === 'online' ? 'Online Order (Fulfilling Whse #9001)' : 'SYNTHETIC NORTH') : opts.warehouse,
    })
    return id
  }

  /** lineTotalCents defaults to round(unitPriceCents × quantity); pass unitPriceCents null + lineTotalCents for unpriced lines. */
  item(
    receiptId: string,
    opts: { itemNumber: string; description?: string; quantity?: number; unitPriceCents?: number | null; lineTotalCents?: number },
  ): string {
    const quantity = opts.quantity ?? 1
    const unit = opts.unitPriceCents === undefined ? 100 : opts.unitPriceCents
    const line = opts.lineTotalCents ?? Math.round((unit ?? 0) * quantity)
    const id = this.id('i')
    this.items.push({
      id,
      purchaseId: receiptId,
      itemNumber: opts.itemNumber,
      description: opts.description ?? `SYNTHETIC ITEM ${opts.itemNumber}`,
      quantity,
      lineTotalCents: line,
      unitPriceCents: unit,
    })
    return id
  }

  /** Records a purchase of one item on its own receipt; returns the receipt id. */
  buy(date: string | null, itemNumber: string, unitPriceCents: number | null, quantity = 1, extra: { source?: Source; warehouse?: string | null; description?: string; lineTotalCents?: number } = {}): string {
    const r = this.receipt({ date, ...(extra.source ? { source: extra.source } : {}), ...(extra.warehouse !== undefined ? { warehouse: extra.warehouse } : {}) })
    this.item(r, { itemNumber, unitPriceCents, quantity, ...(extra.description ? { description: extra.description } : {}), ...(extra.lineTotalCents !== undefined ? { lineTotalCents: extra.lineTotalCents } : {}) })
    return r
  }

  ret(opts: {
    itemNumber: string
    date?: string | null
    quantity?: number
    amountCents?: number | null
    transactionId?: string
    transactionTotalCents?: number | null
    description?: string | null
    sourcePurchaseId?: string | null
    warehouse?: string | null
    transactionType?: string | null
  }): string {
    const id = this.id('ret')
    this.returns.push({
      id,
      transactionId: opts.transactionId ?? this.id('t'),
      itemNumber: opts.itemNumber,
      returnDate: opts.date === undefined ? '2024-06-01' : opts.date,
      warehouse: opts.warehouse === undefined ? 'SYNTHETIC NORTH' : opts.warehouse,
      quantity: opts.quantity ?? 1,
      description: opts.description === undefined ? `SYNTHETIC ITEM ${opts.itemNumber}` : opts.description,
      transactionType: opts.transactionType === undefined ? 'Refund' : opts.transactionType,
      merchandiseAmountCents: opts.amountCents === undefined ? 100 : opts.amountCents,
      transactionTotalCents: opts.transactionTotalCents === undefined ? -999_999 : opts.transactionTotalCents,
      sourcePurchaseId: opts.sourcePurchaseId ?? null,
    })
    return id
  }

  adj(opts: { itemNumber: string; date?: string | null; amountCents: number; transactionId?: string; transactionTotalCents?: number; adjustedQuantity?: number | null }): string {
    const id = this.id('adj')
    this.adjustments.push({
      id,
      transactionId: opts.transactionId ?? this.id('t'),
      itemNumber: opts.itemNumber,
      adjustmentDate: opts.date === undefined ? '2024-06-01' : opts.date,
      warehouse: 'SYNTHETIC NORTH',
      amountCents: opts.amountCents,
      adjustedQuantity: opts.adjustedQuantity === undefined ? 1 : opts.adjustedQuantity,
      referenceLineNumbers: [],
      transactionType: 'Sales',
      transactionTotalCents: opts.transactionTotalCents ?? -888_888,
      sourcePurchaseId: null,
    })
    return id
  }

  build(): AnalyticsExportV1 {
    const raw = {
      format: 'costcotracker-analytics',
      formatVersion: 1,
      exportedAt: '2026-11-01T12:00:00Z',
      currency: 'USD',
      receipts: this.receipts,
      items: this.items,
      returns: this.returns,
      priceAdjustments: this.adjustments,
    }
    const result = importExportValue(structuredClone(raw))
    if (!result.ok) throw new Error(`Invalid synthetic dataset: ${JSON.stringify(result.error.issues.slice(0, 5))}`)
    return result.data
  }
}

/** Deterministic PRNG (mulberry32) for generated datasets. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DESCRIPTIONS = [
  'KS BANANAS 3 LB', 'ORGANIC STRAWBERRIES', 'KS PAPER TOWELS 12 ROLL', 'KS BATH TISSUE 30 ROLL', 'ROTISSERIE CHICKEN',
  'KS LARGE EGGS 24 CT', 'KS GREEK YOGURT', 'TORTILLA CHIPS', 'KS SPARKLING WATER', 'KS COFFEE DARK ROAST',
  'KS OLIVE OIL 2L', 'JASMINE RICE 25 LB', 'KS DISH SOAP PODS', 'KS LAUNDRY DETERGENT', 'KS MULTIVITAMIN',
  'KS DOG FOOD 40 LB', 'KS CABERNET SAUVIGNON', 'MENS SOCKS 6 PK', 'LED LIGHT BULBS', 'KS TRASH BAGS 200 CT',
  'FROZEN BLUEBERRIES', 'SOURDOUGH BREAD 2 CT', 'KS SALMON FILLET', 'AVOCADOS 6 CT', 'GROUND BEEF 88/12',
  'WIDGET XL MYSTERY', 'KS SHAMPOO 2 PK', 'HDMI CABLE 2 PK', 'CHRISTMAS ORNAMENTS', 'KS AA BATTERIES 48 CT',
]

/**
 * A larger synthetic dataset over several years with realistic structure:
 * repeat staples with drifting prices, one-offs, fractional quantities,
 * unpriced lines, undated receipts, online orders, returns and adjustments.
 */
export function generateDataset(opts: { receipts: number; itemsPerReceipt: number; returns: number; adjustments: number; seed?: number; catalog?: number }): AnalyticsExportV1 {
  const rand = rng(opts.seed ?? 42)
  const b = new DatasetBuilder()
  const catalog = opts.catalog ?? 400
  const basePrice = Array.from({ length: catalog }, () => 199 + Math.floor(rand() * 4000))
  const warehouses = ['SYNTHETIC NORTH', 'Synthetic North ', 'SYNTHETIC SOUTH', 'SYNTHETIC EAST', 'Warehouse']
  const start = Date.UTC(2021, 0, 3)
  const purchased: string[] = []
  for (let r = 0; r < opts.receipts; r++) {
    const day = Math.floor((r / opts.receipts) * 365 * 5)
    const undated = rand() < 0.01
    const date = undated ? null : new Date(start + day * 86_400_000).toISOString().slice(0, 10)
    const online = rand() < 0.15
    const receipt = b.receipt({
      date,
      source: online ? 'online' : 'warehouse',
      warehouse: online ? `Online Order (Fulfilling Whse #${900 + Math.floor(rand() * 3)})` : warehouses[Math.floor(rand() * warehouses.length)]!,
      whse: !online && rand() < 0.05,
    })
    const lines = 1 + Math.floor(rand() * opts.itemsPerReceipt * 2)
    const used = new Set<number>()
    for (let l = 0; l < lines; l++) {
      // Skewed popularity: low indices are staples.
      const k = Math.min(catalog - 1, Math.floor(Math.pow(rand(), 2.5) * catalog))
      if (used.has(k) && !online) continue
      used.add(k)
      const years = day / 365
      const unit = Math.round(basePrice[k]! * Math.pow(1.03, years) * (1 + (rand() - 0.5) * 0.1))
      const weighed = k % 17 === 0
      const quantity = weighed ? Math.round((0.5 + rand() * 3) * 100) / 100 : 1 + Math.floor(rand() * 3)
      const unpriced = k % 23 === 0
      const itemNumber = String(1_000_000 + k)
      b.item(receipt, {
        itemNumber,
        description: DESCRIPTIONS[k % DESCRIPTIONS.length]!,
        quantity,
        unitPriceCents: unpriced ? null : unit,
        lineTotalCents: Math.round(unit * quantity),
      })
      purchased.push(itemNumber)
    }
  }
  let previous: string | null = null
  for (let i = 0; i < opts.returns; i++) {
    const itemNumber = purchased[Math.floor(rand() * purchased.length)]!
    // Returns come in pairs sharing one transaction (same date/warehouse/type/total), distinct items.
    const shareTransaction = i % 2 === 1 && previous !== itemNumber
    const txn = shareTransaction ? `t_ret_${i - 1}` : `t_ret_${i}`
    b.ret({
      itemNumber,
      transactionId: txn,
      date: '2024-03-15',
      quantity: 1,
      amountCents: rand() < 0.1 ? null : 500 + Math.floor(rand() * 5000),
      transactionTotalCents: -12_345,
    })
    previous = itemNumber
  }
  for (let i = 0; i < opts.adjustments; i++) {
    b.adj({ itemNumber: purchased[Math.floor(rand() * purchased.length)]!, amountCents: 100 + Math.floor(rand() * 900), date: '2024-04-0' + (1 + (i % 9)) })
  }
  return b.build()
}
