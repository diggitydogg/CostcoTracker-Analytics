/**
 * Analytics Export V1 — Zod schema.
 *
 * Mirrors `ANALYTICS_DATA_CONTRACT.md`, which is aligned with the CostcoTracker
 * iOS SQLite tables (`receipts`, `items`, `item_returns`, `price_adjustments`).
 * This module is the single source of truth for what a V1 file may contain. It
 * deliberately:
 *
 * - accepts only integer cents for money (no floats, no strings),
 * - accepts only calendar dates (`YYYY-MM-DD`) for purchase/return/adjustment
 *   dates, so a date never shifts across a timezone boundary,
 * - requires every field to be present; unknown values are `null`, never `""`
 *   or a guessed default (only `sourcePurchaseId` may be omitted),
 * - has no field for receipt/transaction barcodes or online order numbers,
 * - strips unknown fields (the importer reports their *names* as warnings).
 */
import { z } from 'zod'

export const EXPORT_FORMAT = 'costcotracker-analytics' as const
export const FORMAT_VERSION_V1 = 1 as const

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** True when `value` is a real calendar date written as `YYYY-MM-DD`. */
export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  // Day 0 of the following month is the last day of `month`. Computed in UTC
  // purely as integer arithmetic; the date itself is never treated as a moment.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= daysInMonth
}

const ISO_DATE_TIME_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

/** True when `value` is an ISO-8601 date-time with an explicit zone. */
export function isZonedDateTime(value: string): boolean {
  if (!ISO_DATE_TIME_WITH_ZONE.test(value)) return false
  if (!isCalendarDate(value.slice(0, 10))) return false
  return !Number.isNaN(Date.parse(value))
}

const nonEmptyText = (what: string) =>
  z
    .string({ error: `Expected text for ${what}.` })
    .refine((v) => v.trim().length > 0, { error: `${what} must not be empty.` })

const nonEmptyId = nonEmptyText('identifier')

/** Text that may be unknown. Unknown is `null`; an empty string is rejected, not coerced. */
const nullableText = (what: string) =>
  z
    .string({ error: `Expected text or null for ${what}.` })
    .refine((v) => v.trim().length > 0, { error: `Use null instead of empty text when ${what} is unknown.` })
    .nullable()

const calendarDate = z
  .string({ error: 'Expected a calendar date (YYYY-MM-DD).' })
  .refine(isCalendarDate, { error: 'Expected a real calendar date written as YYYY-MM-DD.' })

const cents = z
  .number({ error: 'Expected an integer number of cents.' })
  .refine(Number.isSafeInteger, { error: 'Money must be a whole number of cents.' })

const nonNegativeCents = cents.refine((v) => v >= 0, {
  error: 'This amount is recorded as a magnitude and must not be negative.',
})

/** Strictly positive, finite, not necessarily an integer (e.g. weighed items). */
const positiveQuantity = z
  .number({ error: 'Expected a number for quantity.' })
  .refine(Number.isFinite, { error: 'Quantity must be a finite number.' })
  .refine((v) => v > 0, { error: 'Quantity must be greater than zero.' })

/**
 * How the iOS app keyed this receipt in its `receipts.barcode` column. The key
 * itself is never exported; only its kind, because it changes what the row means.
 *
 * - `transactionBarcode`        a real warehouse receipt barcode
 * - `synthesizedWarehouseKey`   `WHSE_<date>_<warehouse>` made up by the app when
 *                               Costco returned no barcode (not a real barcode;
 *                               same-day trips to one warehouse share one key)
 * - `onlineOrderKey`            an online order number (or order header ID)
 * - `synthetic`                 test/demo data, never produced by the iOS app
 */
export const RECEIPT_IDENTIFIER_KINDS = [
  'transactionBarcode',
  'synthesizedWarehouseKey',
  'onlineOrderKey',
  'synthetic',
] as const

const ALLOWED_IDENTIFIER_KINDS: Record<'warehouse' | 'online' | 'synthetic', readonly string[]> = {
  warehouse: ['transactionBarcode', 'synthesizedWarehouseKey'],
  online: ['onlineOrderKey'],
  synthetic: ['synthetic'],
}

const receiptShapeV1 = {
  id: nonEmptyId,
  sourceType: z.enum(['warehouse', 'online', 'synthetic'], {
    error: 'Expected sourceType "warehouse", "online", or "synthetic".',
  }),
  identifierKind: z.enum(RECEIPT_IDENTIFIER_KINDS, {
    error: `Expected identifierKind to be one of: ${RECEIPT_IDENTIFIER_KINDS.join(', ')}.`,
  }),
  purchaseDate: calendarDate.nullable(),
  /** The single warehouse/source string stored by the app (`receipts.warehouse`). */
  warehouse: nullableText('warehouse'),
}

export const receiptSchemaV1 = z.object(receiptShapeV1).superRefine((receipt, ctx) => {
  if (!ALLOWED_IDENTIFIER_KINDS[receipt.sourceType].includes(receipt.identifierKind)) {
    ctx.addIssue({
      code: 'custom',
      path: ['identifierKind'],
      message: `identifierKind is not valid for sourceType "${receipt.sourceType}".`,
    })
  }
})

const itemShapeV1 = {
  id: nonEmptyId,
  purchaseId: nonEmptyId,
  itemNumber: nonEmptyText('itemNumber'),
  /** As stored; the app may store an empty description. */
  description: z.string({ error: 'Expected text for description.' }),
  quantity: positiveQuantity,
  /** Net line total after instant savings, in cents. */
  lineTotalCents: nonNegativeCents,
  /** Stored net unit price in cents, or null when it is not a whole number of cents. */
  unitPriceCents: nonNegativeCents.nullable(),
}

export const itemSchemaV1 = z.object(itemShapeV1)

const sourcePurchaseId = nonEmptyId
  .nullable()
  .optional()
  .transform((v) => v ?? null)

const returnShapeV1 = {
  id: nonEmptyId,
  /** Opaque ID of the return transaction; never equal to any receipt ID. */
  transactionId: nonEmptyId,
  itemNumber: nonEmptyText('itemNumber'),
  returnDate: calendarDate.nullable(),
  warehouse: nullableText('warehouse'),
  /** Returned units for this item in this transaction (stored as a positive magnitude). */
  quantity: positiveQuantity,
  description: nullableText('description'),
  transactionType: nullableText('transactionType'),
  /** Returned merchandise value for this item (positive magnitude), if recorded. */
  merchandiseAmountCents: nonNegativeCents.nullable(),
  /** Signed total of the whole transaction, repeated on each row of that transaction. */
  transactionTotalCents: cents.nullable(),
  sourcePurchaseId,
}

export const returnSchemaV1 = z.object(returnShapeV1)

const priceAdjustmentShapeV1 = {
  id: nonEmptyId,
  /** Opaque ID of the adjustment transaction; never equal to any receipt ID. */
  transactionId: nonEmptyId,
  /** Item number the adjustment applies to. */
  itemNumber: nonEmptyText('itemNumber'),
  adjustmentDate: calendarDate.nullable(),
  warehouse: nullableText('warehouse'),
  /** Recorded savings (positive magnitude). */
  amountCents: nonNegativeCents,
  adjustedQuantity: positiveQuantity.nullable(),
  /** Item numbers of the receipt lines ("/<item>" lines) that carried the adjustment. */
  referenceLineNumbers: z.array(nonEmptyText('reference line number'), {
    error: 'Expected a list of reference line numbers.',
  }),
  transactionType: nullableText('transactionType'),
  /** Signed total of the whole transaction, repeated on each row of that transaction. */
  transactionTotalCents: cents,
  sourcePurchaseId,
}

export const priceAdjustmentSchemaV1 = z.object(priceAdjustmentShapeV1)

const envelopeShapeV1 = {
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(FORMAT_VERSION_V1),
  exportedAt: z
    .string({ error: 'Expected an ISO-8601 timestamp.' })
    .refine(isZonedDateTime, {
      error: 'Expected an ISO-8601 timestamp with a timezone, e.g. 2026-10-31T18:00:00Z.',
    }),
  currency: z
    .string({ error: 'Expected a currency code.' })
    .regex(/^[A-Z]{3}$/, { error: 'Expected a three-letter ISO 4217 currency code, e.g. USD.' }),
  receipts: z.array(receiptSchemaV1, { error: 'Expected a list of receipts.' }),
  items: z.array(itemSchemaV1, { error: 'Expected a list of items.' }),
  returns: z.array(returnSchemaV1, { error: 'Expected a list of returns.' }),
  priceAdjustments: z.array(priceAdjustmentSchemaV1, {
    error: 'Expected a list of price adjustments.',
  }),
}

export const exportSchemaV1 = z.object(envelopeShapeV1)

/** Field names each record type knows about; anything else is reported as unknown. */
export const KNOWN_FIELDS_V1 = {
  envelope: Object.keys(envelopeShapeV1),
  receipts: Object.keys(receiptShapeV1),
  items: Object.keys(itemShapeV1),
  returns: Object.keys(returnShapeV1),
  priceAdjustments: Object.keys(priceAdjustmentShapeV1),
} as const

/** Raw shape of a V1 file, before parsing (`sourcePurchaseId` may be absent). */
export type AnalyticsExportV1Input = z.input<typeof exportSchemaV1>
/** Parsed and normalized V1 data: every field is present (possibly null). */
export type AnalyticsExportV1 = z.output<typeof exportSchemaV1>

export type Receipt = AnalyticsExportV1['receipts'][number]
export type Item = AnalyticsExportV1['items'][number]
export type Return = AnalyticsExportV1['returns'][number]
export type PriceAdjustment = AnalyticsExportV1['priceAdjustments'][number]
export type ReceiptSourceType = Receipt['sourceType']
export type ReceiptIdentifierKind = Receipt['identifierKind']
