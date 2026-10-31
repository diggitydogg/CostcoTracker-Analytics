/**
 * Pure importer for CostcoTracker analytics exports.
 *
 * Pipeline (each step stops at the first category of failure so the user gets
 * the most useful message first):
 *
 *   1. size guard           — refuse absurdly large input before parsing
 *   2. JSON parse           — generic message, never echoes file contents
 *   3. envelope sniffing    — `format` and `formatVersion` checked on their own
 *                             so a wrong/unsupported file gets a targeted message
 *   4. V1 schema            — field types, money, dates (Zod)
 *   5. dataset integrity    — duplicate IDs, dangling purchase references
 *   6. warnings             — unknown field *names* that were ignored
 *
 * Nothing here touches the DOM, storage, or the network.
 */
import type { z } from 'zod'
import {
  EXPORT_FORMAT,
  FORMAT_VERSION_V1,
  KNOWN_FIELDS_V1,
  exportSchemaV1,
  type AnalyticsExportV1,
} from '../export/v1'

/** Hard upper bound for an import file. Generous for years of receipts. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024
/** Maximum number of individual problems listed back to the user. */
export const MAX_REPORTED_ISSUES = 50

export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [FORMAT_VERSION_V1]

export type ImportErrorKind =
  | 'too-large'
  | 'unreadable'
  | 'empty'
  | 'invalid-json'
  | 'not-an-object'
  | 'wrong-format'
  | 'missing-version'
  | 'unsupported-version'
  | 'invalid-data'

export type ImportIssue = {
  /** Location inside the file, e.g. `items[3].unitPriceCents`. Never contains values. */
  path: string
  message: string
}

export type ImportError = {
  kind: ImportErrorKind
  /** One-sentence summary suitable for a heading. */
  message: string
  /** What the user can do about it. */
  hint: string
  issues: ImportIssue[]
  /** Number of issues found in total (may exceed `issues.length`). */
  totalIssueCount: number
}

export type ImportWarning = {
  kind: 'unknown-fields'
  /** Where the unknown fields appeared, e.g. `items`. */
  location: string
  /** Unknown field names (values are never kept). */
  fields: string[]
  /** Number of records that contained at least one of these fields. */
  recordCount: number
}

export type ImportResult =
  | { ok: true; data: AnalyticsExportV1; warnings: ImportWarning[] }
  | { ok: false; error: ImportError }

function fail(
  kind: ImportErrorKind,
  message: string,
  hint: string,
  allIssues: ImportIssue[] = [],
): ImportResult {
  return {
    ok: false,
    error: {
      kind,
      message,
      hint,
      issues: allIssues.slice(0, MAX_REPORTED_ISSUES),
      totalIssueCount: allIssues.length,
    },
  }
}

const RE_EXPORT_HINT =
  'Export a fresh analytics file from the CostcoTracker iOS app and try again. If this keeps happening, the export may be from an incompatible app version.'

export function tooLargeError(): ImportError {
  return {
    kind: 'too-large',
    message: 'This file is too large to import.',
    hint: `Files up to ${MAX_IMPORT_BYTES / (1024 * 1024)} MB are supported.`,
    issues: [],
    totalIssueCount: 0,
  }
}

/** Parse the text of a file. */
export function importExportText(text: string): ImportResult {
  // String length is UTF-16 code units; close enough for a safety guard.
  if (text.length > MAX_IMPORT_BYTES) {
    return { ok: false, error: tooLargeError() }
  }
  if (text.trim().length === 0) {
    return fail('empty', 'This file is empty.', RE_EXPORT_HINT)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // The engine's message can quote file contents, so it is intentionally dropped.
    return fail(
      'invalid-json',
      'This file is not valid JSON.',
      'The file may be truncated or corrupted. Make sure you selected the .json file exported by CostcoTracker, not a screenshot, PDF, or edited copy.',
    )
  }
  return importExportValue(parsed)
}

/** Validate an already-parsed value (also used to re-validate saved data). */
export function importExportValue(value: unknown): ImportResult {
  if (!isPlainObject(value)) {
    return fail(
      'not-an-object',
      'This file does not contain a CostcoTracker analytics export.',
      'The top level of the file must be a JSON object. ' + RE_EXPORT_HINT,
    )
  }

  if (value.format !== EXPORT_FORMAT) {
    return fail(
      'wrong-format',
      'This is not a CostcoTracker analytics export.',
      `Expected the file to declare "format": "${EXPORT_FORMAT}". Make sure you exported the analytics file from CostcoTracker rather than another app's backup or a different CostcoTracker export.`,
    )
  }

  const version = value.formatVersion
  if (version === undefined || version === null) {
    return fail(
      'missing-version',
      'This export does not declare a format version.',
      'Every analytics export must include "formatVersion". ' + RE_EXPORT_HINT,
    )
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return fail(
      'unsupported-version',
      'This export has an unreadable format version.',
      '"formatVersion" must be a whole number. ' + RE_EXPORT_HINT,
    )
  }
  if (!SUPPORTED_FORMAT_VERSIONS.includes(version)) {
    const newer = version > Math.max(...SUPPORTED_FORMAT_VERSIONS)
    return fail(
      'unsupported-version',
      `Export format version ${version} is not supported.`,
      newer
        ? `This site supports version ${SUPPORTED_FORMAT_VERSIONS.join(', ')}. The export was made by a newer CostcoTracker; reload this page to get the latest analytics site, or export again in a compatible format.`
        : `This site supports version ${SUPPORTED_FORMAT_VERSIONS.join(', ')}. Update the CostcoTracker iOS app and export again.`,
    )
  }

  const result = exportSchemaV1.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => toImportIssue(issue, value))
    return fail(
      'invalid-data',
      `This export has ${issues.length} ${issues.length === 1 ? 'problem' : 'problems'} with its data.`,
      'Nothing was imported. Invalid values are rejected rather than guessed so your analytics stay accurate. ' +
        RE_EXPORT_HINT,
      issues,
    )
  }

  const integrityIssues = checkIntegrity(result.data)
  if (integrityIssues.length > 0) {
    return fail(
      'invalid-data',
      `This export has ${integrityIssues.length} ${integrityIssues.length === 1 ? 'inconsistency' : 'inconsistencies'} between records.`,
      'Nothing was imported. Records must have unique IDs, may only reference receipts that are present in the file, and rows from the same transaction must agree with each other. ' +
        RE_EXPORT_HINT,
      integrityIssues,
    )
  }

  return { ok: true, data: result.data, warnings: collectUnknownFieldWarnings(value) }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Formats a Zod path as `items[3].unitPriceCents`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out.length === 0 ? String(segment) : `.${String(segment)}`
  }
  return out.length === 0 ? '(file)' : out
}

function toImportIssue(issue: z.core.$ZodIssue, raw: unknown): ImportIssue {
  const path = formatPath(issue.path)
  // A missing required field surfaces as a type error; say so plainly instead.
  if (isMissing(raw, issue.path)) {
    return { path, message: 'Required field is missing.' }
  }
  return { path, message: issue.message }
}

/** True when the last key of `path` is absent from its parent object. */
function isMissing(raw: unknown, path: readonly PropertyKey[]): boolean {
  if (path.length === 0) return false
  let parent: unknown = raw
  for (const segment of path.slice(0, -1)) {
    if (typeof parent !== 'object' || parent === null) return false
    parent = (parent as Record<PropertyKey, unknown>)[segment]
  }
  if (!isPlainObject(parent)) return false
  return !Object.hasOwn(parent, path[path.length - 1] as PropertyKey)
}

/** Tolerance when checking a line total against unit price × quantity. */
const LINE_TOTAL_TOLERANCE_CENTS = 1

/**
 * Cross-record checks that a schema cannot express:
 * - IDs are unique within each collection,
 * - every item belongs to a receipt in the file,
 * - an item's whole-cent unit price agrees with its line total,
 * - an explicit `sourcePurchaseId` on a return/adjustment points at a receipt
 *   in the file (absent links are fine and are never inferred),
 * - return/adjustment `transactionId`s never coincide with receipt IDs, so a
 *   transaction can never be silently joined to a purchase,
 * - at most one return (and one adjustment) per transaction and item number,
 *   mirroring the iOS `UNIQUE(transaction_barcode, item_number)` constraint,
 * - rows sharing a `transactionId` agree on transaction-level fields (date,
 *   warehouse, type, total), so a per-transaction total is unambiguous.
 */
export function checkIntegrity(data: AnalyticsExportV1): ImportIssue[] {
  const issues: ImportIssue[] = []

  const collections = ['receipts', 'items', 'returns', 'priceAdjustments'] as const
  for (const name of collections) {
    const firstIndexById = new Map<string, number>()
    data[name].forEach((record, index) => {
      const first = firstIndexById.get(record.id)
      if (first === undefined) firstIndexById.set(record.id, index)
      else
        issues.push({
          path: `${name}[${index}].id`,
          message: `Duplicate ID; the same ID is already used by ${name}[${first}].`,
        })
    })
  }

  const receiptIds = new Set(data.receipts.map((r) => r.id))
  data.items.forEach((item, index) => {
    if (!receiptIds.has(item.purchaseId)) {
      issues.push({
        path: `items[${index}].purchaseId`,
        message: 'References a receipt that is not in this file.',
      })
    }
    if (
      item.unitPriceCents !== null &&
      Math.abs(item.unitPriceCents * item.quantity - item.lineTotalCents) > LINE_TOTAL_TOLERANCE_CENTS
    ) {
      issues.push({
        path: `items[${index}].lineTotalCents`,
        message: 'Does not match unitPriceCents × quantity.',
      })
    }
  })

  type TransactionFields = { path: string; date: string | null; warehouse: string | null; type: string | null; total: number | null }
  const transactions = new Map<string, TransactionFields>()

  for (const name of ['returns', 'priceAdjustments'] as const) {
    const firstIndexByKey = new Map<string, number>()
    data[name].forEach((record, index) => {
      const at = `${name}[${index}]`
      if (record.sourcePurchaseId !== null && !receiptIds.has(record.sourcePurchaseId)) {
        issues.push({ path: `${at}.sourcePurchaseId`, message: 'References a receipt that is not in this file.' })
      }
      if (receiptIds.has(record.transactionId)) {
        issues.push({
          path: `${at}.transactionId`,
          message: 'Must not equal a receipt ID; transaction IDs are a separate namespace.',
        })
      }

      // JSON-encoded tuple: unambiguous for any characters in either part.
      const key = JSON.stringify([record.transactionId, record.itemNumber])
      const first = firstIndexByKey.get(key)
      if (first === undefined) firstIndexByKey.set(key, index)
      else
        issues.push({
          path: at,
          message: `Same transactionId and itemNumber as ${name}[${first}]; each item appears once per transaction.`,
        })

      const fields: TransactionFields = {
        path: at,
        date: 'returnDate' in record ? record.returnDate : record.adjustmentDate,
        warehouse: record.warehouse,
        type: record.transactionType,
        total: record.transactionTotalCents,
      }
      const seen = transactions.get(record.transactionId)
      if (!seen) {
        transactions.set(record.transactionId, fields)
        return
      }
      const conflicts: string[] = []
      if (seen.date !== fields.date) conflicts.push('date')
      if (seen.warehouse !== fields.warehouse) conflicts.push('warehouse')
      if (seen.type !== fields.type) conflicts.push('transactionType')
      if (seen.total !== fields.total) conflicts.push('transactionTotalCents')
      if (conflicts.length > 0) {
        issues.push({
          path: `${at}.transactionId`,
          message: `Shares a transaction with ${seen.path} but disagrees on ${conflicts.join(', ')}.`,
        })
      }
    })
  }

  return issues
}

/** Names (never values) of fields this version does not understand. */
export function collectUnknownFieldWarnings(raw: Record<string, unknown>): ImportWarning[] {
  const warnings: ImportWarning[] = []

  const envelopeUnknown = Object.keys(raw).filter(
    (key) => !(KNOWN_FIELDS_V1.envelope as readonly string[]).includes(key),
  )
  if (envelopeUnknown.length > 0) {
    warnings.push({
      kind: 'unknown-fields',
      location: 'file',
      fields: envelopeUnknown.sort(),
      recordCount: 1,
    })
  }

  for (const name of ['receipts', 'items', 'returns', 'priceAdjustments'] as const) {
    const known = KNOWN_FIELDS_V1[name] as readonly string[]
    const records = raw[name]
    if (!Array.isArray(records)) continue
    const unknown = new Set<string>()
    let recordCount = 0
    for (const record of records) {
      if (!isPlainObject(record)) continue
      let found = false
      for (const key of Object.keys(record)) {
        if (!known.includes(key)) {
          unknown.add(key)
          found = true
        }
      }
      if (found) recordCount += 1
    }
    if (unknown.size > 0) {
      warnings.push({
        kind: 'unknown-fields',
        location: name,
        fields: [...unknown].sort(),
        recordCount,
      })
    }
  }

  return warnings
}
