// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { importExportValue } from './import/importExport'
import { summarizeImport } from './summary'
import { syntheticExport } from '../test/fixtures'

function load(mutate?: (d: ReturnType<typeof syntheticExport>) => void) {
  const raw = syntheticExport()
  mutate?.(raw)
  const result = importExportValue(raw)
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

describe('summarizeImport', () => {
  it('counts rows in each collection of the synthetic fixture', () => {
    const summary = summarizeImport(load())
    expect(summary).toEqual({
      receiptCount: 4,
      receiptCountBySource: { warehouse: 2, online: 1, synthetic: 1 },
      itemCount: 7,
      returnCount: 3,
      priceAdjustmentCount: 2,
      purchaseDateRange: { first: '2026-01-04', last: '2026-02-09' },
      receiptsWithoutDate: 1,
    })
  })

  it('counts receipts by source type', () => {
    const summary = summarizeImport(
      load((d) => {
        d.receipts[1]!.sourceType = 'online'
        d.receipts[1]!.identifierKind = 'onlineOrderKey'
      }),
    )
    expect(summary.receiptCountBySource).toEqual({ warehouse: 1, online: 2, synthetic: 1 })
  })

  it('reports no date range rather than inventing one when no dates exist', () => {
    const summary = summarizeImport(
      load((d) => {
        for (const r of d.receipts) r.purchaseDate = null
      }),
    )
    expect(summary.purchaseDateRange).toBeNull()
    expect(summary.receiptsWithoutDate).toBe(4)
  })

  it('handles an export with empty collections', () => {
    const summary = summarizeImport(
      load((d) => {
        d.receipts = []
        d.items = []
        d.returns = []
        d.priceAdjustments = []
      }),
    )
    expect(summary.receiptCount).toBe(0)
    expect(summary.itemCount).toBe(0)
    expect(summary.purchaseDateRange).toBeNull()
  })
})
