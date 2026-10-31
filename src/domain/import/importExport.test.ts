// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MAX_IMPORT_BYTES,
  MAX_REPORTED_ISSUES,
  formatPath,
  importExportText,
  importExportValue,
  type ImportResult,
} from './importExport'
import { syntheticExport, syntheticExportText } from '../../test/fixtures'

function expectError(result: ImportResult) {
  if (result.ok) throw new Error('expected import to fail')
  return result.error
}

function expectOk(result: ImportResult) {
  if (!result.ok) throw new Error(`expected import to succeed: ${JSON.stringify(result.error)}`)
  return result
}

describe('valid import', () => {
  it('accepts the synthetic V1 fixture', () => {
    const { data, warnings } = expectOk(importExportText(syntheticExportText()))
    expect(data.format).toBe('costcotracker-analytics')
    expect(data.formatVersion).toBe(1)
    expect(data.currency).toBe('USD')
    expect(data.receipts).toHaveLength(4)
    expect(data.items).toHaveLength(7)
    expect(data.returns).toHaveLength(2)
    expect(data.priceAdjustments).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('normalizes absent optional fields to null without inventing values', () => {
    const { data } = expectOk(importExportText(syntheticExportText()))
    // receipt 004 omits onlineOrderNumber entirely
    expect(data.receipts[3]).toEqual({
      id: 'synthetic-receipt-004',
      sourceType: 'synthetic',
      purchaseDate: null,
      warehouseName: 'Synthetic Warehouse North',
      warehouseNumber: 'SYN-01',
      onlineOrderNumber: null,
    })
    // return 002 omits sourcePurchaseId: it must stay unlinked
    expect(data.returns[1]!.sourcePurchaseId).toBeNull()
    expect(data.returns[1]!.amountCents).toBeNull()
  })

  it('preserves missing quantity/price as null and non-integer quantities as-is', () => {
    const { data } = expectOk(importExportText(syntheticExportText()))
    const byWeight = data.items.find((i) => i.id === 'synthetic-item-005')!
    expect(byWeight.quantity).toBe(1.37)
    expect(byWeight.unitPriceCents).toBeNull()
    expect(byWeight.lineTotalCents).toBe(411)
    const unnumbered = data.items.find((i) => i.id === 'synthetic-item-007')!
    expect(unnumbered.itemNumber).toBeNull()
    expect(unnumbered.quantity).toBeNull()
  })

  it('accepts negative line totals (e.g. instant-savings lines) as long as they are integer cents', () => {
    expectOk(importExportText(syntheticExportText((d) => (d.items[0]!.lineTotalCents = -500))))
  })

  it('accepts empty collections', () => {
    const result = importExportText(
      syntheticExportText((d) => {
        d.receipts = []
        d.items = []
        d.returns = []
        d.priceAdjustments = []
      }),
    )
    expectOk(result)
  })

  it('ignores unknown fields but reports their names (never values)', () => {
    const { data, warnings } = expectOk(
      importExportText(
        syntheticExportText((d) => {
          d.futureEnvelopeField = 'secret-envelope-value'
          d.items[0]!.categoryHint = 'secret-item-value'
          d.items[1]!.categoryHint = 'x'
          d.items[1]!.barcode = 'secret-barcode'
        }),
      ),
    )
    expect(warnings).toEqual([
      { kind: 'unknown-fields', location: 'file', fields: ['futureEnvelopeField'], recordCount: 1 },
      { kind: 'unknown-fields', location: 'items', fields: ['barcode', 'categoryHint'], recordCount: 2 },
    ])
    expect(JSON.stringify(warnings)).not.toContain('secret')
    // Unknown fields are stripped from the imported data.
    expect(JSON.stringify(data)).not.toContain('secret')
    expect(data).not.toHaveProperty('futureEnvelopeField')
  })
})

describe('malformed input', () => {
  it('rejects invalid JSON without echoing file contents', () => {
    const error = expectError(importExportText('{"format": "costcotracker-analytics", PRIVATE-DATA'))
    expect(error.kind).toBe('invalid-json')
    expect(JSON.stringify(error)).not.toContain('PRIVATE-DATA')
  })

  it('rejects truncated JSON', () => {
    const text = syntheticExportText()
    expect(expectError(importExportText(text.slice(0, text.length / 2))).kind).toBe('invalid-json')
  })

  it('rejects an empty file', () => {
    expect(expectError(importExportText('   \n')).kind).toBe('empty')
  })

  it.each([['[]'], ['null'], ['"text"'], ['42']])('rejects non-object top level %s', (text) => {
    expect(expectError(importExportText(text)).kind).toBe('not-an-object')
  })

  it('rejects oversized input before parsing', () => {
    const error = expectError(importExportText(' '.repeat(MAX_IMPORT_BYTES + 1)))
    expect(error.kind).toBe('too-large')
  })
})

describe('format and version', () => {
  it('rejects a missing format', () => {
    const error = expectError(importExportText(syntheticExportText((d) => delete d.format)))
    expect(error.kind).toBe('wrong-format')
  })

  it('rejects a different format', () => {
    const error = expectError(importExportText(syntheticExportText((d) => (d.format = 'costcotracker-backup'))))
    expect(error.kind).toBe('wrong-format')
    expect(error.message).toMatch(/not a CostcoTracker analytics export/)
  })

  it('rejects a missing formatVersion', () => {
    const error = expectError(importExportText(syntheticExportText((d) => delete d.formatVersion)))
    expect(error.kind).toBe('missing-version')
  })

  it('rejects a newer formatVersion with an update hint', () => {
    const error = expectError(importExportText(syntheticExportText((d) => (d.formatVersion = 2))))
    expect(error.kind).toBe('unsupported-version')
    expect(error.message).toBe('Export format version 2 is not supported.')
    expect(error.hint).toMatch(/newer CostcoTracker/)
  })

  it('rejects an older formatVersion with an app-update hint', () => {
    const error = expectError(importExportText(syntheticExportText((d) => (d.formatVersion = 0))))
    expect(error.kind).toBe('unsupported-version')
    expect(error.hint).toMatch(/Update the CostcoTracker iOS app/)
  })

  it.each([['1'], [1.5], [true]])('does not coerce formatVersion %j', (version) => {
    const error = expectError(importExportText(syntheticExportText((d) => (d.formatVersion = version))))
    expect(error.kind).toBe('unsupported-version')
  })
})

describe('invalid fields', () => {
  function issuesFor(mutate: (d: ReturnType<typeof syntheticExport>) => void) {
    const error = expectError(importExportText(syntheticExportText(mutate)))
    expect(error.kind).toBe('invalid-data')
    return error.issues
  }

  it('rejects fractional cents', () => {
    expect(issuesFor((d) => (d.items[0]!.unitPriceCents = 21.99))).toEqual([
      { path: 'items[0].unitPriceCents', message: 'Money must be a whole number of cents.' },
    ])
  })

  it('rejects money given as a string instead of coercing it', () => {
    const issues = issuesFor((d) => (d.items[0]!.lineTotalCents = '2199'))
    expect(issues).toHaveLength(1)
    expect(issues[0]!.path).toBe('items[0].lineTotalCents')
  })

  it('rejects impossible calendar dates', () => {
    expect(issuesFor((d) => (d.receipts[0]!.purchaseDate = '2026-02-30'))[0]!.path).toBe('receipts[0].purchaseDate')
  })

  it('rejects timestamps where a calendar date is required (avoids timezone day shifts)', () => {
    expect(issuesFor((d) => (d.receipts[0]!.purchaseDate = '2026-01-04T23:30:00-08:00'))[0]!.path).toBe(
      'receipts[0].purchaseDate',
    )
    expect(issuesFor((d) => (d.returns[0]!.returnDate = '02/20/2026'))[0]!.path).toBe('returns[0].returnDate')
  })

  it('rejects an exportedAt without a timezone', () => {
    expect(issuesFor((d) => (d.exportedAt = '2026-10-31T18:00:00'))[0]!.path).toBe('exportedAt')
  })

  it('rejects an invalid currency code', () => {
    expect(issuesFor((d) => (d.currency = 'usd'))[0]!.path).toBe('currency')
  })

  it('rejects negative quantity', () => {
    expect(issuesFor((d) => (d.items[1]!.quantity = -2))).toEqual([
      { path: 'items[1].quantity', message: 'Quantity must not be negative.' },
    ])
  })

  it('rejects an unknown sourceType', () => {
    expect(issuesFor((d) => (d.receipts[0]!.sourceType = 'gas-station'))[0]!.path).toBe('receipts[0].sourceType')
  })

  it('reports missing required fields plainly', () => {
    expect(issuesFor((d) => delete d.items[2]!.purchaseId)).toEqual([
      { path: 'items[2].purchaseId', message: 'Required field is missing.' },
    ])
    expect(issuesFor((d) => delete (d as Record<string, unknown>).priceAdjustments)).toEqual([
      { path: 'priceAdjustments', message: 'Required field is missing.' },
    ])
  })

  it('reports a missing enum field as missing, not as an invalid option', () => {
    expect(issuesFor((d) => delete d.receipts[0]!.sourceType)).toEqual([
      { path: 'receipts[0].sourceType', message: 'Required field is missing.' },
    ])
  })

  it('rejects empty identifiers', () => {
    expect(issuesFor((d) => (d.receipts[0]!.id = '  '))[0]!.path).toBe('receipts[0].id')
  })

  it('rejects a collection that is not an array', () => {
    expect(issuesFor((d) => ((d as Record<string, unknown>).items = {}))[0]!.path).toBe('items')
  })

  it('never includes offending values in messages', () => {
    const error = expectError(
      importExportText(
        syntheticExportText((d) => {
          d.receipts[0]!.purchaseDate = 'SENSITIVE-DATE'
          d.items[0]!.unitPriceCents = 'SENSITIVE-PRICE'
          d.receipts[1]!.sourceType = 'SENSITIVE-SOURCE'
        }),
      ),
    )
    expect(error.issues).toHaveLength(3)
    expect(JSON.stringify(error)).not.toContain('SENSITIVE')
  })

  it('caps the number of reported issues but keeps the total', () => {
    const error = expectError(
      importExportText(
        syntheticExportText((d) => {
          d.items = Array.from({ length: MAX_REPORTED_ISSUES + 25 }, (_, i) => ({
            id: `bad-${i}`,
            purchaseId: 'synthetic-receipt-001',
            itemNumber: null,
            description: 'SYNTHETIC',
            quantity: 1,
            unitPriceCents: 0.5,
            lineTotalCents: 1,
          }))
        }),
      ),
    )
    expect(error.issues).toHaveLength(MAX_REPORTED_ISSUES)
    expect(error.totalIssueCount).toBe(MAX_REPORTED_ISSUES + 25)
  })
})

describe('dataset integrity', () => {
  it('rejects duplicate IDs within a collection', () => {
    const error = expectError(importExportText(syntheticExportText((d) => (d.items[3]!.id = d.items[0]!.id))))
    expect(error.kind).toBe('invalid-data')
    expect(error.issues).toEqual([
      { path: 'items[3].id', message: 'Duplicate ID; the same ID is already used by items[0].' },
    ])
  })

  it('rejects items that reference a missing receipt', () => {
    const error = expectError(importExportText(syntheticExportText((d) => (d.items[0]!.purchaseId = 'nope'))))
    expect(error.issues).toEqual([
      { path: 'items[0].purchaseId', message: 'References a receipt that is not in this file.' },
    ])
  })

  it('rejects an explicit return/adjustment link to a missing receipt', () => {
    const error = expectError(
      importExportText(
        syntheticExportText((d) => {
          d.returns[0]!.sourcePurchaseId = 'nope'
          d.priceAdjustments[0]!.sourcePurchaseId = 'nope'
        }),
      ),
    )
    expect(error.issues.map((i) => i.path)).toEqual(['returns[0].sourcePurchaseId', 'priceAdjustments[0].sourcePurchaseId'])
  })

  it('allows the same ID in different collections', () => {
    expectOk(importExportText(syntheticExportText((d) => (d.returns[0]!.id = 'synthetic-item-001'))))
  })
})

describe('importExportValue', () => {
  it('re-validates already-parsed data (round trip of normalized output)', () => {
    const first = expectOk(importExportValue(syntheticExport()))
    const second = expectOk(importExportValue(structuredClone(first.data)))
    expect(second.data).toEqual(first.data)
  })
})

describe('formatPath', () => {
  it('formats nested paths', () => {
    expect(formatPath(['items', 3, 'unitPriceCents'])).toBe('items[3].unitPriceCents')
    expect(formatPath([])).toBe('(file)')
  })
})
