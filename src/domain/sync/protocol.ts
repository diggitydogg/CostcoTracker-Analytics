/**
 * Sync protocol V1 — request shapes and pure validation, shared by the browser
 * (JSON import upload) and the server. See docs/CLOUD_ARCHITECTURE.md §5.
 */
import { z } from 'zod'
import {
  FORMAT_VERSION_V1,
  isAllowedIdentifierKind,
  isZonedDateTime,
  itemShapeV1,
  nonEmptyId,
  priceAdjustmentSchemaV1,
  receiptShapeV1,
  returnSchemaV1,
  type AnalyticsExportV1,
  type Item,
  type PriceAdjustment,
  type Receipt,
  type Return,
} from '../export/v1'
import { checkIntegrity, formatPath, type ImportIssue } from '../import/importExport'

export const SYNC_LIMITS = {
  /** Receipts + items + returns + price adjustments per batch. */
  maxRowsPerBatch: 200,
  maxBatchBytes: 256 * 1024,
  maxCompleteBytes: 2 * 1024 * 1024,
  maxBatchesPerRun: 10_000,
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const syncModeSchema = z.enum(['incremental', 'full'])
export type SyncMode = z.infer<typeof syncModeSchema>

export const startRunSchema = z.object({
  runId: z.string().regex(UUID, { error: 'runId must be a lower-case UUID.' }),
  mode: syncModeSchema,
  formatVersion: z.literal(FORMAT_VERSION_V1, { error: `Only formatVersion ${FORMAT_VERSION_V1} is supported.` }),
  exportedAt: z.string().refine(isZonedDateTime, { error: 'exportedAt must be an ISO-8601 timestamp with a timezone.' }),
  currency: z.string().regex(/^[A-Z]{3}$/, { error: 'currency must be a three-letter code.' }),
  requestId: nonEmptyId.nullable().optional().transform((v) => v ?? null),
})
export type StartRunRequest = z.output<typeof startRunSchema>

const { purchaseId: _purchaseId, ...bundleItemShape } = itemShapeV1
void _purchaseId

/** A receipt travels with its complete item set (items carry no purchaseId). */
export const receiptBundleSchema = z
  .object({
    ...receiptShapeV1,
    items: z.array(z.object(bundleItemShape), { error: 'Expected a list of items.' }),
  })
  .superRefine((receipt, ctx) => {
    if (!isAllowedIdentifierKind(receipt.sourceType, receipt.identifierKind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['identifierKind'],
        message: `identifierKind is not valid for sourceType "${receipt.sourceType}".`,
      })
    }
  })
export type ReceiptBundle = z.output<typeof receiptBundleSchema>

export const syncBatchSchema = z.object({
  receipts: z.array(receiptBundleSchema, { error: 'Expected a list of receipt bundles.' }),
  returns: z.array(returnSchemaV1, { error: 'Expected a list of returns.' }),
  priceAdjustments: z.array(priceAdjustmentSchemaV1, { error: 'Expected a list of price adjustments.' }),
})
export type SyncBatch = z.output<typeof syncBatchSchema>

export const completeRunSchema = z.object({
  batchCount: z.number().int().min(0).max(SYNC_LIMITS.maxBatchesPerRun),
  manifest: z
    .object({
      receiptIds: z.array(nonEmptyId),
      returnIds: z.array(nonEmptyId),
      priceAdjustmentIds: z.array(nonEmptyId),
    })
    .nullable()
    .optional()
    .transform((v) => v ?? null),
})
export type CompleteRunRequest = z.output<typeof completeRunSchema>

/** Field names that suggest credentials/session material. Never accepted in sync payloads. */
export const FORBIDDEN_KEY_PATTERN = /cookie|password|passwd|token|authorization|session|secret|bearer|barcode/i

/** Paths (never values) of object keys that look like credentials, at any depth. */
export function findForbiddenKeys(value: unknown, path: (string | number)[] = []): string[] {
  const found: string[] = []
  if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...findForbiddenKeys(v, [...path, i])))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) found.push(formatPath([...path, key]))
      else found.push(...findForbiddenKeys(v, [...path, key]))
    }
  }
  return found
}

export function countBatchRows(batch: SyncBatch): number {
  return (
    batch.receipts.reduce((n, r) => n + 1 + r.items.length, 0) + batch.returns.length + batch.priceAdjustments.length
  )
}

/** Flattens a batch into Export V1 collections (items regain their purchaseId). */
export function batchToExportCollections(batch: SyncBatch): Pick<
  AnalyticsExportV1,
  'receipts' | 'items' | 'returns' | 'priceAdjustments'
> {
  const receipts: Receipt[] = []
  const items: Item[] = []
  for (const { items: bundleItems, ...receipt } of batch.receipts) {
    receipts.push(receipt)
    for (const item of bundleItems) items.push({ ...item, purchaseId: receipt.id })
  }
  return { receipts, items, returns: batch.returns, priceAdjustments: batch.priceAdjustments }
}

export type BatchValidation =
  | { ok: true; batch: SyncBatch; rowCount: number }
  | { ok: false; code: 'forbidden_field' | 'invalid_batch' | 'batch_too_large'; issues: ImportIssue[] }

/**
 * Validates one batch body. Checks, in order: credential-like keys, schema,
 * size, then the same within-file integrity rules as the JSON importer (with
 * purchase references resolved later against the database).
 */
export function validateSyncBatch(raw: unknown): BatchValidation {
  const forbidden = findForbiddenKeys(raw)
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'forbidden_field',
      issues: forbidden.map((path) => ({ path, message: 'Credential-like fields are never accepted.' })),
    }
  }
  const parsed = syncBatchSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_batch',
      issues: parsed.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
    }
  }
  const rowCount = countBatchRows(parsed.data)
  if (rowCount > SYNC_LIMITS.maxRowsPerBatch) {
    return {
      ok: false,
      code: 'batch_too_large',
      issues: [{ path: '(batch)', message: `A batch may contain at most ${SYNC_LIMITS.maxRowsPerBatch} rows.` }],
    }
  }
  const collections = batchToExportCollections(parsed.data)
  const issues = checkIntegrity(
    { format: 'costcotracker-analytics', formatVersion: 1, exportedAt: '', currency: '', ...collections },
    { purchaseReferencesResolvedElsewhere: true },
  )
  if (issues.length > 0) return { ok: false, code: 'invalid_batch', issues }
  return { ok: true, batch: parsed.data, rowCount }
}

/**
 * Splits a validated export into protocol batches for upload (JSON import).
 * Keeps each receipt with all its items, and every return/adjustment
 * transaction whole, as the server requires. A single receipt with more than
 * `maxRows - 1` items cannot be uploaded and is reported as an error.
 */
export function toSyncBatches(data: AnalyticsExportV1, maxRows: number = SYNC_LIMITS.maxRowsPerBatch): SyncBatch[] {
  const itemsByReceipt = new Map<string, Omit<Item, 'purchaseId'>[]>()
  for (const { purchaseId, ...item } of data.items) {
    const list = itemsByReceipt.get(purchaseId) ?? []
    list.push(item)
    itemsByReceipt.set(purchaseId, list)
  }

  type Unit =
    | { kind: 'receipt'; rows: number; bundle: ReceiptBundle }
    | { kind: 'transaction'; rows: number; returns: Return[]; priceAdjustments: PriceAdjustment[] }
  const units: Unit[] = data.receipts.map((receipt) => {
    const items = itemsByReceipt.get(receipt.id) ?? []
    return { kind: 'receipt', rows: 1 + items.length, bundle: { ...receipt, items } }
  })

  const transactions = new Map<string, { returns: Return[]; priceAdjustments: PriceAdjustment[] }>()
  const txn = (id: string) => {
    let t = transactions.get(id)
    if (!t) transactions.set(id, (t = { returns: [], priceAdjustments: [] }))
    return t
  }
  for (const r of data.returns) txn(r.transactionId).returns.push(r)
  for (const a of data.priceAdjustments) txn(a.transactionId).priceAdjustments.push(a)
  for (const t of transactions.values()) {
    units.push({ kind: 'transaction', rows: t.returns.length + t.priceAdjustments.length, ...t })
  }

  const batches: SyncBatch[] = []
  let current: SyncBatch = { receipts: [], returns: [], priceAdjustments: [] }
  let rows = 0
  for (const unit of units) {
    if (unit.rows > maxRows) throw new Error(`A single receipt or transaction has ${unit.rows} rows; the limit is ${maxRows}.`)
    if (rows + unit.rows > maxRows) {
      batches.push(current)
      current = { receipts: [], returns: [], priceAdjustments: [] }
      rows = 0
    }
    if (unit.kind === 'receipt') current.receipts.push(unit.bundle)
    else {
      current.returns.push(...unit.returns)
      current.priceAdjustments.push(...unit.priceAdjustments)
    }
    rows += unit.rows
  }
  if (rows > 0 || batches.length === 0) batches.push(current)
  return batches
}
