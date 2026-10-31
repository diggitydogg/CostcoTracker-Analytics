# Analytics Export Contract — V1

This document defines the contract between the CostcoTracker iOS app and CostcoTracker Analytics.

V1 matches the iOS data model as of `diggitydogg/CostcoTracker` commit `4028b84` (`CostcoTracker/DBManager.swift`). It covers the SQLite tables `receipts`, `items`, `item_returns` and `price_adjustments`, and the Swift models `ReceiptMatch`, `ItemPurchaseRecord`, `ItemReturnRecord` and `PriceAdjustmentRecord`. Every field below maps to a stored column. Nothing in V1 requires the iOS app to collect data it does not already store.

The machine-checked definition is `src/domain/export/v1.ts`. The importer rejects files that break any rule below and does not coerce them.

## General rules

| Rule | Detail |
|---|---|
| Money | Integer cents (`…Cents`). The iOS app stores dollars as SQLite `REAL`, so the exporter converts with `round(value × 100)`. Strings, fractions and floats are rejected. |
| Dates | Calendar dates, `YYYY-MM-DD`. iOS stores `normalizedDate()` output, which is `yyyy-MM-dd` or `""`. `""` is exported as `null`. Timestamps are rejected so a purchase day can never shift with time zones. |
| Unknown text | `null`. An empty string (`""`) in SQLite means "unknown" for `warehouse`, `transactionType` and return `description`, so it is exported as `null`. The importer rejects `""` in these fields. |
| Presence | Every field is required. Unknown values are `null`. The only field that may be omitted is `sourcePurchaseId`, which then means `null`. |
| Quantities | Finite and `> 0`, and not necessarily whole numbers. iOS only stores positive quantities. Return quantities are stored as magnitudes. |
| Unknown fields | Ignored for forward compatibility. Only their names are reported, and their values are never kept. |
| Item numbers | As stored by iOS, which strips leading zeros (`normalizedNumber`). |

## Envelope

```json
{
  "format": "costcotracker-analytics",
  "formatVersion": 1,
  "exportedAt": "2026-10-31T18:00:00Z",
  "currency": "USD",
  "receipts": [],
  "items": [],
  "returns": [],
  "priceAdjustments": []
}
```

- `exportedAt` is an ISO-8601 timestamp with a time zone.
- `currency` is an ISO 4217 code. iOS does not store currency, so the exporter writes `"USD"` (all ingested Costco US data is USD).

## Receipt / order: `receipts` table

```ts
type AnalyticsReceiptV1 = {
  id: string                       // opaque, see "Export IDs"
  sourceType: "warehouse" | "online" | "synthetic"
  identifierKind: "transactionBarcode" | "synthesizedWarehouseKey" | "onlineOrderKey" | "synthetic"
  purchaseDate: string | null      // receipts.date
  warehouse: string | null         // receipts.warehouse, verbatim
}
```

**Source columns:** `receipts(barcode TEXT PRIMARY KEY, date TEXT, warehouse TEXT)`.

### `warehouse`
iOS stores one warehouse/source string, so V1 exports that one string and does not split it into a name and a number. Examples of stored values:
- a Costco `warehouseName` for warehouse receipts. When the name was missing, iOS stores the literal `"Warehouse"`; see Known mismatches.
- `"Online Order (Fulfilling Whse #<n>)"` for online orders.

### `sourceType`
Derived by the exporter using the app's own rule (`ReceiptMatch.isOnlineOrder` / `ItemPurchaseRecord.isOnlineOrder`):
- `online` when `warehouse` starts with `"Online Order"`;
- `warehouse` otherwise.

`synthetic` is reserved for test and demo files. The iOS app never produces it.

### `identifierKind`
Says how iOS keyed the row in `receipts.barcode`. The key itself is never exported. The kind matters because it changes what the row means.

| `identifierKind` | iOS rule | `sourceType` |
|---|---|---|
| `onlineOrderKey` | `sourceType == online`. The key is `orderNumber`, falling back to `orderHeaderId` or the literal `"ONLINE"`. | `online` |
| `synthesizedWarehouseKey` | The barcode starts with `WHSE_`. iOS made the key `WHSE_<date>_<warehouse>` because Costco returned no barcode. It is **not** a receipt barcode, and it must never be treated as one or exported as one. | `warehouse` |
| `transactionBarcode` | Any other non-empty barcode (`hasWarehouseReceiptBarcode == true`). | `warehouse` |
| `synthetic` | Test and demo data only. | `synthetic` |

The importer rejects a combination of `sourceType` and `identifierKind` not listed above.

## Purchased item: `items` table

```ts
type AnalyticsItemV1 = {
  id: string                  // "i_<items.id>"
  purchaseId: string          // receipt export ID of items.receipt_barcode
  itemNumber: string          // items.item_number (non-empty)
  description: string         // items.description, verbatim (may be "")
  quantity: number            // items.quantity (> 0)
  lineTotalCents: number      // round(unit_price × quantity × 100), ≥ 0
  unitPriceCents: number | null
}
```

**Source columns:** `items(id, receipt_barcode, item_number, description, unit_price REAL, quantity REAL)`.

### Price semantics
- iOS stores **no line total**. It stores a *net* `unit_price`, worked out as `(sum of line amounts + instant-savings discount lines) / quantity`. The app's own `ItemPurchaseRecord.lineTotal` is `unitPrice × quantity`.
- V1 exports that product, rounded to the cent, as `lineTotalCents`. This is the recorded net amount paid for the line, after instant savings.
- `unitPriceCents` is `unit_price × 100` when that is a whole number of cents (within 1e-6), and `null` otherwise. For example, $10.00 spread over 3 units is `null`. In that case analytics computes a unit price as `lineTotalCents / quantity` and labels it as computed.
- The importer rejects an item whose whole-cent `unitPriceCents × quantity` differs from `lineTotalCents` by more than 1 cent.

### What iOS stores as items
- Warehouse lines are grouped per receipt and item number, so a receipt has one row per item number.
- Online order lines are stored one row per line item. One order can contain the same item number more than once.
- Lines whose net total would be negative are not stored.
- Lines from `Refund` transactions are not stored as items.

## Return: `item_returns` table

```ts
type AnalyticsReturnV1 = {
  id: string                          // "ret_<item_returns.id>"
  transactionId: string               // opaque transaction ID, see "Export IDs"
  itemNumber: string                  // item_number
  returnDate: string | null           // return_date
  warehouse: string | null            // warehouse
  quantity: number                    // returned_quantity (> 0, magnitude)
  description: string | null          // description
  transactionType: string | null      // transaction_type, e.g. "Refund", "Sales"
  merchandiseAmountCents: number | null   // merchandise_amount (≥ 0, magnitude)
  transactionTotalCents: number | null    // transaction_total (signed, whole transaction)
  sourcePurchaseId?: string | null    // ALWAYS null from current iOS
}
```

**Source columns:** `item_returns(id, transaction_barcode, item_number, return_date, warehouse, returned_quantity, description, transaction_type, merchandise_amount, transaction_total, UNIQUE(transaction_barcode, item_number))`.

### Field semantics
- **Which lines count as returns.** iOS records negative-unit merchandise lines in *any* transaction type, because real `"Sales"` transactions can contain returns. Lines starting with `/` (adjustment and promo references) are excluded.
- **`quantity`** is the sum of `|unit|` over the qualifying lines for that item in that transaction.
- **`merchandiseAmountCents`** is the sum of `|amount|` for that item. It is `null` when Costco gave no amount.
- **`transactionTotalCents`** is the receipt `total` of the **whole** transaction, which can include other items and tax. It is repeated on every row of the same transaction. **Never sum it across rows.** Group by `transactionId` first.
- **`sourcePurchaseId`** must be `null` or absent. The iOS database does not know which purchase a returned unit came from. `transaction_barcode` identifies the *return* transaction, not the original purchase, so it must never be used to derive this link.

### Importer checks
- `(transactionId, itemNumber)` is unique, matching the SQLite `UNIQUE` constraint.
- Rows that share a `transactionId` agree on date, warehouse, `transactionType` and `transactionTotalCents`.

## Price adjustment: `price_adjustments` table

```ts
type AnalyticsPriceAdjustmentV1 = {
  id: string                          // "adj_<price_adjustments.id>"
  transactionId: string               // opaque transaction ID, see "Export IDs"
  itemNumber: string                  // item_number (the adjusted item)
  adjustmentDate: string | null       // adjustment_date
  warehouse: string | null            // warehouse
  amountCents: number                 // adjustment_amount (≥ 0, savings magnitude)
  adjustedQuantity: number | null     // adjusted_quantity (> 0)
  referenceLineNumbers: string[]      // reference_line_number split on ","; "" → []
  transactionType: string | null      // transaction_type
  transactionTotalCents: number       // transaction_total (signed, whole transaction)
  sourcePurchaseId?: string | null    // ALWAYS null from current iOS
}
```

**Source columns:** `price_adjustments(id, transaction_barcode, item_number, adjustment_date, warehouse, adjustment_amount REAL NOT NULL, adjusted_quantity, reference_line_number, transaction_type, transaction_total REAL NOT NULL, UNIQUE(transaction_barcode, item_number))`.

### What iOS records as an adjustment
Only standalone adjustment transactions:
- the total is negative;
- `totalItemCount` is 0;
- every negative line is a `/<item number>` line;
- there are no normal sale lines.

These are actual recorded adjustments, not price-match opportunities.

### Field semantics
- **`amountCents`** is the sum of `|amount|` for the adjusted item.
- **`adjustedQuantity`** is the sum of `|unit|`. It is `null` when no line had a non-zero unit.
- **`referenceLineNumbers`** are the item numbers of the `/…` receipt lines that carried the adjustment. They are kept for traceability back to the receipt.
- **`transactionTotalCents`** has the same per-transaction semantics as for returns.
- **`sourcePurchaseId`** must be `null` or absent. iOS does not record which purchase was adjusted.

The importer applies the same uniqueness and per-transaction consistency checks as for returns.

## Export IDs

IDs give provenance *within an export*. They must never reveal a receipt barcode, a `WHSE_` key or an online order number.

| Record | Export ID | Stability |
|---|---|---|
| receipt | `"r_" + token("receipt", receipts.barcode)` | Stable across exports from the same install. |
| return / adjustment `transactionId` | `"t_" + token("transaction", transaction_barcode)` | Stable across exports. Because of domain separation it never equals a receipt ID, so it can't be joined to a purchase. |
| item | `"i_" + items.id` | Stable within one export. It changes when that receipt is re-synced, because iOS deletes and re-inserts the receipt's items. |
| return | `"ret_" + item_returns.id` | Stable. iOS updates the row in place (`ON CONFLICT … DO UPDATE`), so the row ID is kept. |
| adjustment | `"adj_" + price_adjustments.id` | Stable, for the same reason as returns. |

`token(domain, value)` is defined as:

```
base64url( HMAC-SHA256( exportKey, domain + "\u0000" + value ) )[0..22]
```

- `exportKey` is 32 random bytes generated once per install. It is stored only on the device (for example in the Keychain) and is **never exported**.
- Without the key, a token can't be reversed or brute-forced from the structured, fairly low-entropy barcode.
- The `domain` prefix keeps receipt IDs and transaction IDs in separate namespaces. That stops an analytics join from treating "same barcode" as a return-to-purchase relationship.
- The importer treats every ID as an opaque string. It only checks that IDs are unique and that references resolve, and it rejects a `transactionId` equal to any receipt ID.

## Privacy exclusions

Never include:
- `receipts.barcode`, `item_returns.transaction_barcode` or `price_adjustments.transaction_barcode`, whether real barcodes or synthetic `WHSE_…` keys. Analytics does not need them; opaque IDs cover provenance.
- online order numbers or order header IDs. They are only present as `receipts.barcode` for online rows.
- `online_sync_metadata` and `online_order_sync_state`
- saved returns and return photos
- the export key
- Costco login credentials, cookies, bearer tokens and session storage
- payment card data, the full account profile, unrelated app preferences, SideStore data and device identifiers

## Known mismatches and limitations (iOS data model vs. analytics needs)

These come from how iOS currently stores data. V1 represents them honestly and does not hide them.

1. **Same-day `WHSE_` collisions.** A synthesized warehouse key is `WHSE_<date>_<warehouse>`. Two same-day trips to the same warehouse without barcodes share one key. iOS `INSERT OR REPLACE`s the receipt and replaces its items, so only the later trip is kept. Trip counts for `synthesizedWarehouseKey` receipts are a lower bound.
2. **Placeholder warehouse values.**
   - A missing warehouse name is stored as the literal `"Warehouse"`.
   - A missing online fulfilling warehouse number is stored as `#847`.
   - The exporter cannot tell either placeholder from a real value, so analytics should not over-interpret them.
3. **Unclear online order keys.** The online `receipts.barcode` value may be `orderNumber`, `orderHeaderId` or the literal `"ONLINE"`. In the last case several orders may collapse into one receipt.
4. **No stored line totals or gross prices.**
   - Only a net unit price is stored.
   - Instant-savings discounts are folded into it and are not available separately.
   - Gross (pre-discount) spend can't be exported.
5. **Item IDs are not stable across re-syncs** of the same receipt (see Export IDs).
6. **Transaction totals are per transaction.** For returns and adjustments, `transaction_total` covers the whole transaction, including tax and other lines. It is not a per-item refund amount.
7. **No currency column.** The exporter asserts `USD`.
8. **No return-to-purchase or adjustment-to-purchase link exists.** `sourcePurchaseId` is always `null` from current iOS.
9. **No exporter yet.** iOS currently has only a full-backup package (`BackupManager.swift`), not this analytics export. An iOS exporter must implement the mapping above.
