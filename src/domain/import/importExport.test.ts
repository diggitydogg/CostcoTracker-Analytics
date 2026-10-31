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
    expect(data.returns).toHaveLength(3)
    expect(data.priceAdjustments).toHaveLength(2)
    expect(warnings).toEqual([])
  })

  it('keeps the single warehouse string and the identifier kind as exported', () => {
    const { data } = expectOk(importExportText(syntheticExportText()))
    expect(data.receipts.map((r) => [r.sourceType, r.identifierKind, r.warehouse])).toEqual([
      ['warehouse', 'transactionBarcode', 'SYNTHETIC NORTH'],
      ['warehouse', 'synthesizedWarehouseKey', 'SYNTHETIC SOUTH'],
      ['online', 'onlineOrderKey', 'Online Order (Fulfilling Whse #9001)'],
      ['synthetic', 'synthetic', null],
    ])
  })

  it('preserves fractional quantities and a null unit price without inventing one', () => {
    const { data } = expectOk(importExportText(syntheticExportText()))
    const byWeight = data.items.find((i) => i.id === 'i_5')!
    expect(byWeight.quantity).toBe(1.37)
    expect(byWeight.unitPriceCents).toBeNull()
    expect(byWeight.lineTotalCents).toBe(411)
    // 1000 / 3 is not a whole number of cents, so the unit price stays null.
    const split = data.items.find((i) => i.id === 'i_7')!
    expect(split.unitPriceCents).toBeNull()
    expect(split.lineTotalCents).toBe(1000)
    expect(split.description).toBe('')
  })

  it('imports every return field', () => {
    const { data } = expectOk(importExportText(syntheticExportText()))
    expect(data.returns[0]).toEqual({
      id: 'ret_1',
      transactionId: 't_synthetic0001',
      itemNumber: '9000005',
      returnDate: '2026-02-20',
      warehouse: 'SYNTHETIC NORTH',
      quantity: 1,
      description: 'SYNTHETIC DESK LAMP',
      transactionType: 'Refund',
      merchandiseAmountCents: 3999,
      transactionTotalCents: -6650,
      sourcePurchaseId: null,
    })
  })

  it('keeps unknown return values null (no amount, total, or description invented)', () => {
    const { data } = expectOk(importExportText(syntheticExportText()))
    const partial = data.returns.find((r) => r.id === 'ret_3')!
    expect(partial.quantity).toBe(0.5)
    expect(partial.description).toBeNull()
    expect(partial.merchandiseAmountCents).toBeNull()
    expect(partial.transactionTotalCents).toBeNull()
  })

  it('imports every price-adjustment field', () => {
    const { data } = expectOk(importExportText(syntheticExportText()))
    expect(data.priceAdjustments[0]).toEqual({
      id: 'adj_1',
      transactionId: 't_synthetic0003',
      itemNumber: '9000001',
      adjustmentDate: '2026-01-25',
      warehouse: 'SYNTHETIC SOUTH',
      amountCents: 300,
      adjustedQuantity: 1,
      referenceLineNumbers: ['9100001'],
      transactionType: 'Sales',
      transactionTotalCents: -300,
      sourcePurchaseId: null,
    })
    expect(data.priceAdjustments[1]).toMatchObject({
      adjustmentDate: null,
      warehouse: null,
      adjustedQuantity: null,
      referenceLineNumbers: [],
      transactionType: null,
    })
  })

  it('normalizes an omitted sourcePurchaseId to null and never infers a link', () => {
    const { data } = expectOk(importExportText(syntheticExportText()))
    // ret_2 and adj_2 omit sourcePurchaseId entirely.
    expect(data.returns[1]!.sourcePurchaseId).toBeNull()
    expect(data.priceAdjustments[1]!.sourcePurchaseId).toBeNull()
    // ret_1 and ret_2 share a transaction but still are not linked to any purchase.
    expect(data.returns.every((r) => r.sourcePurchaseId === null)).toBe(true)
  })

  it('accepts an explicit sourcePurchaseId that points at a receipt in the file', () => {
    const { data } = expectOk(
      importExportText(
        syntheticExportText((d) => {
          d.returns[0]!.sourcePurchaseId = 'r_synthetic0003'
          d.priceAdjustments[0]!.sourcePurchaseId = 'r_synthetic0002'
        }),
      ),
    )
    expect(data.returns[0]!.sourcePurchaseId).toBe('r_synthetic0003')
    expect(data.priceAdjustments[0]!.sourcePurchaseId).toBe('r_synthetic0002')
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

  it.each([[0], [-2]])('rejects item quantity %j (the app only stores positive quantities)', (q) => {
    expect(issuesFor((d) => (d.items[1]!.quantity = q))).toEqual([
      { path: 'items[1].quantity', message: 'Quantity must be greater than zero.' },
    ])
  })

  it('rejects a negative line total (the app stores only non-negative net totals)', () => {
    expect(issuesFor((d) => (d.items[0]!.lineTotalCents = -500)).map((i) => i.path)).toContain(
      'items[0].lineTotalCents',
    )
  })

  it('rejects a missing or empty item number', () => {
    expect(issuesFor((d) => (d.items[0]!.itemNumber = null))[0]!.path).toBe('items[0].itemNumber')
    expect(issuesFor((d) => (d.items[0]!.itemNumber = ''))[0]!.path).toBe('items[0].itemNumber')
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
            purchaseId: 'r_synthetic0001',
            itemNumber: '9000001',
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

describe('receipt fields', () => {
  function pathsFor(mutate: (d: ReturnType<typeof syntheticExport>) => void) {
    const error = expectError(importExportText(syntheticExportText(mutate)))
    return error.issues.map((i) => i.path)
  }

  it.each([
    ['warehouse', 'onlineOrderKey'],
    ['warehouse', 'synthetic'],
    ['online', 'transactionBarcode'],
    ['online', 'synthesizedWarehouseKey'],
    ['synthetic', 'transactionBarcode'],
  ])('rejects sourceType %s with identifierKind %s', (sourceType, identifierKind) => {
    expect(
      pathsFor((d) => {
        d.receipts[0]!.sourceType = sourceType
        d.receipts[0]!.identifierKind = identifierKind
      }),
    ).toEqual(['receipts[0].identifierKind'])
  })

  it('rejects an unknown identifierKind', () => {
    expect(pathsFor((d) => (d.receipts[0]!.identifierKind = 'barcode'))).toEqual(['receipts[0].identifierKind'])
  })

  it('rejects empty warehouse text instead of treating it as missing', () => {
    expect(pathsFor((d) => (d.receipts[0]!.warehouse = ''))).toEqual(['receipts[0].warehouse'])
  })

  it('requires the warehouse field to be present (null when unknown)', () => {
    expect(pathsFor((d) => delete d.receipts[0]!.warehouse)).toEqual(['receipts[0].warehouse'])
  })

  it('drops barcode-like fields from older drafts and only reports their names', () => {
    const { data, warnings } = expectOk(
      importExportText(
        syntheticExportText((d) => {
          d.receipts[0]!.transactionBarcode = 'SECRET-BARCODE'
          d.receipts[2]!.onlineOrderNumber = 'SECRET-ORDER'
          d.returns[0]!.transactionBarcode = 'SECRET-BARCODE'
        }),
      ),
    )
    expect(warnings.map((w) => [w.location, w.fields])).toEqual([
      ['receipts', ['onlineOrderNumber', 'transactionBarcode']],
      ['returns', ['transactionBarcode']],
    ])
    expect(JSON.stringify(data)).not.toContain('SECRET')
  })
})

describe('item fields', () => {
  it('rejects a whole-cent unit price that disagrees with the line total', () => {
    const error = expectError(importExportText(syntheticExportText((d) => (d.items[1]!.lineTotalCents = 400))))
    expect(error.issues).toEqual([
      { path: 'items[1].lineTotalCents', message: 'Does not match unitPriceCents × quantity.' },
    ])
  })

  it('tolerates a one-cent rounding difference for fractional quantities', () => {
    expectOk(
      importExportText(
        syntheticExportText((d) => {
          d.items[4]!.unitPriceCents = 300 // 300 × 1.37 = 411
          d.items[4]!.lineTotalCents = 412
        }),
      ),
    )
  })
})

describe('return fields', () => {
  function issuesFor(mutate: (d: ReturnType<typeof syntheticExport>) => void) {
    const error = expectError(importExportText(syntheticExportText(mutate)))
    expect(error.kind).toBe('invalid-data')
    return error.issues
  }

  it.each([
    ['transactionId', ''],
    ['transactionId', null],
    ['itemNumber', null],
    ['itemNumber', ''],
    ['quantity', null],
    ['quantity', 0],
    ['quantity', -1],
    ['returnDate', '2026-02-30'],
    ['returnDate', '2026-02-20T10:00:00Z'],
    ['warehouse', ''],
    ['warehouse', 7],
    ['description', ''],
    ['transactionType', ''],
    ['merchandiseAmountCents', 39.99],
    ['merchandiseAmountCents', -3999],
    ['merchandiseAmountCents', '3999'],
    ['transactionTotalCents', -66.5],
    ['transactionTotalCents', '-6650'],
    ['sourcePurchaseId', ''],
  ])('rejects returns[2].%s = %j', (field, value) => {
    expect(issuesFor((d) => (d.returns[2]![field] = value)).map((i) => i.path)).toEqual([`returns[2].${field}`])
  })

  it.each([
    'transactionId',
    'itemNumber',
    'returnDate',
    'warehouse',
    'quantity',
    'description',
    'transactionType',
    'merchandiseAmountCents',
    'transactionTotalCents',
  ])('requires returns[].%s to be present', (field) => {
    expect(issuesFor((d) => delete d.returns[2]![field])).toEqual([
      { path: `returns[2].${field}`, message: 'Required field is missing.' },
    ])
  })

  it('accepts a positive transaction total (e.g. a sale that also contained a return line)', () => {
    expectOk(importExportText(syntheticExportText((d) => (d.returns[2]!.transactionTotalCents = 1250))))
  })
})

describe('price adjustment fields', () => {
  function issuesFor(mutate: (d: ReturnType<typeof syntheticExport>) => void) {
    const error = expectError(importExportText(syntheticExportText(mutate)))
    expect(error.kind).toBe('invalid-data')
    return error.issues
  }

  it.each([
    ['transactionId', ''],
    ['itemNumber', null],
    ['adjustmentDate', '01/25/2026'],
    ['warehouse', ''],
    ['amountCents', null],
    ['amountCents', 3.5],
    ['amountCents', -300],
    ['adjustedQuantity', 0],
    ['adjustedQuantity', -1],
    ['adjustedQuantity', '1'],
    ['referenceLineNumbers', '9100001'],
    ['referenceLineNumbers', null],
    ['transactionType', ''],
    ['transactionTotalCents', null],
    ['transactionTotalCents', -3.0001],
    ['sourcePurchaseId', 42],
  ])('rejects priceAdjustments[0].%s = %j', (field, value) => {
    expect(issuesFor((d) => (d.priceAdjustments[0]![field] = value)).map((i) => i.path)).toEqual([
      `priceAdjustments[0].${field}`,
    ])
  })

  it('rejects empty entries in referenceLineNumbers', () => {
    expect(issuesFor((d) => (d.priceAdjustments[0]!.referenceLineNumbers = ['9100001', ''])).map((i) => i.path)).toEqual([
      'priceAdjustments[0].referenceLineNumbers[1]',
    ])
  })

  it('accepts several reference line numbers', () => {
    const { data } = expectOk(
      importExportText(syntheticExportText((d) => (d.priceAdjustments[0]!.referenceLineNumbers = ['9100001', '9100002']))),
    )
    expect(data.priceAdjustments[0]!.referenceLineNumbers).toEqual(['9100001', '9100002'])
  })

  it.each([
    'transactionId',
    'itemNumber',
    'adjustmentDate',
    'warehouse',
    'amountCents',
    'adjustedQuantity',
    'referenceLineNumbers',
    'transactionType',
    'transactionTotalCents',
  ])('requires priceAdjustments[].%s to be present', (field) => {
    expect(issuesFor((d) => delete d.priceAdjustments[0]![field])).toEqual([
      { path: `priceAdjustments[0].${field}`, message: 'Required field is missing.' },
    ])
  })
})

describe('transaction integrity', () => {
  function issuesFor(mutate: (d: ReturnType<typeof syntheticExport>) => void) {
    return expectError(importExportText(syntheticExportText(mutate))).issues
  }

  it('rejects a transactionId that equals a receipt ID (no implicit purchase join)', () => {
    expect(issuesFor((d) => {
      d.returns[2]!.transactionId = 'r_synthetic0002'
    })).toEqual([
      {
        path: 'returns[2].transactionId',
        message: 'Must not equal a receipt ID; transaction IDs are a separate namespace.',
      },
    ])
  })

  it('rejects the same item twice in one return transaction', () => {
    expect(issuesFor((d) => (d.returns[1]!.itemNumber = '9000005')).map((i) => i.path)).toEqual(['returns[1]'])
  })

  it('rejects the same item twice in one adjustment transaction', () => {
    expect(
      issuesFor((d) => {
        d.priceAdjustments[1] = { ...d.priceAdjustments[0]!, id: 'adj_2' }
      }).map((i) => i.path),
    ).toEqual(['priceAdjustments[1]'])
  })

  it.each([
    ['transactionTotalCents', -1],
    ['transactionTotalCents', null],
    ['returnDate', '2026-02-21'],
    ['warehouse', 'SYNTHETIC SOUTH'],
    ['transactionType', 'Sales'],
  ])('rejects rows of one transaction that disagree on %s', (field, value) => {
    const issues = issuesFor((d) => (d.returns[1]![field] = value))
    expect(issues).toHaveLength(1)
    expect(issues[0]!.path).toBe('returns[1].transactionId')
    expect(issues[0]!.message).toMatch(/Shares a transaction with returns\[0\]/)
  })

  it('checks consistency across returns and adjustments that share a transaction', () => {
    const issues = issuesFor((d) => (d.priceAdjustments[0]!.transactionId = 't_synthetic0001'))
    expect(issues.map((i) => i.path)).toEqual(['priceAdjustments[0].transactionId'])
  })

  it('allows the same item number in different transactions', () => {
    expectOk(importExportText(syntheticExportText((d) => (d.returns[2]!.itemNumber = '9000005'))))
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
    expectOk(importExportText(syntheticExportText((d) => (d.returns[0]!.id = 'i_1'))))
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
