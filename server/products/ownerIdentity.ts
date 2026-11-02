/**
 * Owner-confirmed product identities (owner-only).
 *
 * For an item number that search could not resolve (provisional or not
 * found), the owner can state what the product is. That becomes our own
 * catalog record with basis `owner-confirmed`:
 * - status `resolved`, so the item number is never searched again;
 * - confidence OWNER_CONFIRMED_CONFIDENCE (1): the owner asserted it; the
 *   basis says it did not come from web evidence;
 * - only the owner's own fields (name, brand, type) plus our receipt text are
 *   written. The request schemas are strict, so no URL, snippet, image, price,
 *   date, warehouse, receipt/order ID or provider data can be sent or saved.
 *
 * Only owner-confirmed records can be edited or removed here. Records resolved
 * automatically (Costco.com, Costco-specialist, corroborated) are refused, so
 * they can never be changed silently. Removing deletes the catalog row only;
 * receipts, purchases and category overrides (browser-side) are untouched, and
 * the item number can be looked up again on a later click.
 */
import {
  OWNER_CONFIRMED_CONFIDENCE,
  OWNER_CONFIRMED_METHOD,
  type ConfirmIdentityRequest,
  type ProductIdentity,
  type UpdateIdentityRequest,
} from '../../src/analytics/products/identityProtocol'
import type { SqlDatabase } from '../db'
import { ApiError } from '../http'
import { COLUMNS, isCatalogMissing, rowToIdentity, type Row } from './identify'

const notConfigured = () =>
  new ApiError(503, 'catalog_not_configured', 'The product catalog is not set up on this cloud yet: apply the D1 migrations (0002), then try again.')

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isCatalogMissing(error)) throw notConfigured()
    throw error
  }
}

async function readRow(db: SqlDatabase, itemNumber: string): Promise<Row | null> {
  return db.first<Row>(`SELECT ${COLUMNS} FROM product_identities WHERE item_number = ?`, [itemNumber])
}

function served(row: Row | null): ProductIdentity {
  const identity = row ? rowToIdentity(row) : null
  if (!identity) throw new Error('owner identity was not stored')
  return identity
}

/** Refuses anything that is not an owner-confirmed record (404 when there is no record at all). */
function assertOwnerConfirmed(row: Row | null): asserts row is Row {
  if (!row || row.status !== 'resolved') throw new ApiError(404, 'identity_not_found', 'There is no confirmed identity for this item number.')
  if (row.resolution_basis !== 'owner-confirmed') {
    throw new ApiError(409, 'not_owner_confirmed', 'This identity was resolved automatically from web evidence and cannot be edited or removed here.')
  }
}

/**
 * Saves the owner's confirmation for an unresolved (or never looked-up) item
 * number. An item number that is already resolved is refused: an automatic
 * record is never overwritten, and an owner-confirmed one is changed with
 * updateOwnerIdentity instead.
 */
export async function confirmOwnerIdentity(db: SqlDatabase, body: ConfirmIdentityRequest, now: Date): Promise<ProductIdentity> {
  return guarded(async () => {
    const at = now.toISOString()
    const { changes } = await db.run(
      `INSERT INTO product_identities (${COLUMNS}) VALUES (?, 'resolved', ?, ?, ?, ?, ?, 'owner-confirmed', NULL, ?, ?, ?, NULL)
       ON CONFLICT (item_number) DO UPDATE SET status = 'resolved', receipt_description = excluded.receipt_description,
         canonical_name = excluded.canonical_name, brand = excluded.brand, product_type = excluded.product_type,
         confidence = excluded.confidence, resolution_basis = 'owner-confirmed', last_outcome = NULL,
         method = excluded.method, resolved_at = excluded.resolved_at, retry_after = NULL
       WHERE product_identities.status <> 'resolved'`,
      [body.itemNumber, body.receiptDescription, body.canonicalName, body.brand, body.productType, OWNER_CONFIRMED_CONFIDENCE, OWNER_CONFIRMED_METHOD, at, at],
    )
    if (changes === 0) {
      const row = await readRow(db, body.itemNumber)
      throw row?.resolution_basis === 'owner-confirmed'
        ? new ApiError(409, 'already_confirmed', 'You already confirmed this item number. Edit that identity instead.')
        : new ApiError(409, 'already_resolved', 'This item number is already in your catalog from web evidence; it cannot be replaced.')
    }
    return served(await readRow(db, body.itemNumber))
  })
}

/** Changes the owner's fields of an owner-confirmed record (resolved_at becomes the time of this confirmation). */
export async function updateOwnerIdentity(db: SqlDatabase, itemNumber: string, body: UpdateIdentityRequest, now: Date): Promise<ProductIdentity> {
  return guarded(async () => {
    assertOwnerConfirmed(await readRow(db, itemNumber))
    await db.run(
      `UPDATE product_identities SET canonical_name = ?, brand = ?, product_type = ?, resolved_at = ?
       WHERE item_number = ? AND status = 'resolved' AND resolution_basis = 'owner-confirmed'`,
      [body.canonicalName, body.brand, body.productType, now.toISOString(), itemNumber],
    )
    return served(await readRow(db, itemNumber))
  })
}

/** Deletes an owner-confirmed record, so the item number is unknown again (a later lookup may search it). */
export async function removeOwnerIdentity(db: SqlDatabase, itemNumber: string): Promise<void> {
  return guarded(async () => {
    assertOwnerConfirmed(await readRow(db, itemNumber))
    await db.run(`DELETE FROM product_identities WHERE item_number = ? AND status = 'resolved' AND resolution_basis = 'owner-confirmed'`, [itemNumber])
  })
}
