/**
 * Analytics Export V1 — Zod schema.
 *
 * Mirrors `ANALYTICS_DATA_CONTRACT.md` (Draft V1). This module is the single
 * source of truth for what a V1 file may contain. It deliberately:
 *
 * - accepts only integer cents for money (no floats, no strings),
 * - accepts only calendar dates (`YYYY-MM-DD`) for purchase/return/adjustment
 *   dates, so a date never shifts across a timezone boundary,
 * - never fills in missing values — absent optional fields become `null`,
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

const nonEmptyId = z
  .string({ error: 'Expected a text identifier.' })
  .refine((v) => v.trim().length > 0, { error: 'Identifier must not be empty.' })

/** Optional text: absent or null both normalize to null. Empty text is kept as-is. */
const optionalText = z
  .string({ error: 'Expected text or null.' })
  .nullable()
  .optional()
  .transform((v) => v ?? null)

const calendarDate = z
  .string({ error: 'Expected a calendar date (YYYY-MM-DD).' })
  .refine(isCalendarDate, { error: 'Expected a real calendar date written as YYYY-MM-DD.' })

const cents = z
  .number({ error: 'Expected an integer number of cents.' })
  .refine(Number.isSafeInteger, { error: 'Money must be a whole number of cents.' })

const quantity = z
  .number({ error: 'Expected a number for quantity.' })
  .refine(Number.isFinite, { error: 'Quantity must be a finite number.' })
  .refine((v) => v >= 0, { error: 'Quantity must not be negative.' })

const nullableCents = cents.nullable()
const nullableQuantity = quantity.nullable()

export const receiptSchemaV1 = z.object({
  id: nonEmptyId,
  sourceType: z.enum(['warehouse', 'online', 'synthetic'], {
    error: 'Expected sourceType "warehouse", "online", or "synthetic".',
  }),
  purchaseDate: calendarDate.nullable(),
  warehouseName: optionalText,
  warehouseNumber: optionalText,
  onlineOrderNumber: optionalText,
})

export const itemSchemaV1 = z.object({
  id: nonEmptyId,
  purchaseId: nonEmptyId,
  itemNumber: z.string({ error: 'Expected text or null for itemNumber.' }).nullable(),
  description: z.string({ error: 'Expected text for description.' }),
  quantity: nullableQuantity,
  unitPriceCents: nullableCents,
  lineTotalCents: nullableCents,
})

export const returnSchemaV1 = z.object({
  id: nonEmptyId,
  itemNumber: z.string({ error: 'Expected text or null for itemNumber.' }).nullable(),
  returnDate: calendarDate
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  quantity: nullableQuantity,
  amountCents: nullableCents.optional().transform((v) => v ?? null),
  sourcePurchaseId: nonEmptyId
    .nullable()
    .optional()
    .transform((v) => v ?? null),
})

export const priceAdjustmentSchemaV1 = z.object({
  id: nonEmptyId,
  itemNumber: z.string({ error: 'Expected text or null for itemNumber.' }).nullable(),
  adjustmentDate: calendarDate
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  amountCents: nullableCents,
  sourcePurchaseId: nonEmptyId
    .nullable()
    .optional()
    .transform((v) => v ?? null),
})

export const exportSchemaV1 = z.object({
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
})

/** Field names each record type knows about; anything else is reported as unknown. */
export const KNOWN_FIELDS_V1 = {
  envelope: Object.keys(exportSchemaV1.shape),
  receipts: Object.keys(receiptSchemaV1.shape),
  items: Object.keys(itemSchemaV1.shape),
  returns: Object.keys(returnSchemaV1.shape),
  priceAdjustments: Object.keys(priceAdjustmentSchemaV1.shape),
} as const

/** Raw shape of a V1 file, before parsing (all optional fields may be absent). */
export type AnalyticsExportV1Input = z.input<typeof exportSchemaV1>
/** Parsed and normalized V1 data: every optional field is present (possibly null). */
export type AnalyticsExportV1 = z.output<typeof exportSchemaV1>

export type Receipt = AnalyticsExportV1['receipts'][number]
export type Item = AnalyticsExportV1['items'][number]
export type Return = AnalyticsExportV1['returns'][number]
export type PriceAdjustment = AnalyticsExportV1['priceAdjustments'][number]
export type ReceiptSourceType = Receipt['sourceType']
