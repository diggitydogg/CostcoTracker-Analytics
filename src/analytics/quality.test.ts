// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAnalyticsSnapshot } from './snapshot'
import { DatasetBuilder } from './test/builder'

describe('data quality', () => {
  it('reports coverage gaps and limitations for this dataset', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', '1', 1000, 1, { description: 'KS BANANAS' })
    b.buy(null, '2', 500, 1, { description: 'WIDGET XL' })
    b.buy('2024-01-03', '3', null, 3, { lineTotalCents: 1000, description: 'KS PAPER TOWELS' })
    b.buy('2024-01-04', '4', 700, 1, { source: 'synthetic', warehouse: null })
    b.buy('2024-01-05', '5', 300, 1, { source: 'online' })
    b.buy('2024-01-06', '6', 300, 1, { warehouse: 'Warehouse' })
    const whse = b.receipt({ date: '2024-01-07', whse: true })
    b.item(whse, { itemNumber: '1', unitPriceCents: 1000 })
    b.receipt({ date: '2024-01-08' }) // no lines
    b.ret({ itemNumber: '1', amountCents: null, date: null })
    b.adj({ itemNumber: '1', amountCents: 50, date: null })
    const q = buildAnalyticsSnapshot(b.build(), { source: { source: 'cloud', excludedTombstonedRecords: 3 } }).quality

    expect(q.totals).toEqual({ receipts: 8, itemLines: 7, returns: 1, priceAdjustments: 1 })
    expect(q.receiptsWithoutDate.count).toBe(1)
    expect(q.itemLinesWithoutDate).toEqual({ count: 1, spendCents: 500 })
    expect(q.receiptsWithoutItems.count).toBe(1)
    expect(q.itemLinesWithoutUnitPrice.count).toBe(1)
    expect(q.itemLinesWithoutUnitPrice.spendShare).toBeCloseTo(1000 / 4800, 12)
    expect(q.returnsWithoutAmount.count).toBe(1)
    expect(q.returnsWithoutDate.count).toBe(1)
    expect(q.adjustmentsWithoutDate.count).toBe(1)
    expect(q.receiptsBySource).toEqual({ warehouse: 6, online: 1, synthetic: 1 })
    expect(q.synthesizedWarehouseKeyReceipts).toBe(1)
    expect(q.placeholderWarehouseReceipts).toBe(1)
    expect(q.uncategorized.itemCount).toBe(4) // WIDGET XL and three generic synthetic descriptions
    expect(q.firstDate).toBe('2024-01-01')
    expect(q.lastDate).toBe('2024-01-08')
    expect(q.inflation.latestYearConfidence).toBeNull()

    const text = q.limitations.join('\n')
    expect(text).toMatch(/merchandise only/)
    expect(text).toMatch(/1 receipt\(s\) have no purchase date/)
    expect(text).toMatch(/no recorded unit price/)
    expect(text).toMatch(/had no barcode/)
    expect(text).toMatch(/synthetic/)
    expect(text).toMatch(/3 cloud record\(s\) no longer on the iPhone/)
    expect(text).toMatch(/not enough repeat-price data/)
  })

  it('stays quiet about problems that do not exist', () => {
    const b = new DatasetBuilder()
    b.buy('2024-01-01', '1', 1000)
    const text = buildAnalyticsSnapshot(b.build()).quality.limitations.join('\n')
    expect(text).not.toMatch(/no purchase date|no barcode|synthetic|no recorded unit price/)
  })
})
