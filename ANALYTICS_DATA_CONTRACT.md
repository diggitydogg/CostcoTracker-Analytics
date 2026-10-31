# Analytics Export Contract — Draft V1

This document defines the target contract between CostcoTracker iOS and CostcoTracker Analytics.

The actual iOS implementation must be based on the current CostcoTracker data model. Do not invent source fields merely to satisfy this draft. If a field cannot be exported reliably, document that and adjust the contract before implementation.

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

## Receipt / purchase source

```ts
type AnalyticsReceiptV1 = {
  id: string
  sourceType: "warehouse" | "online" | "synthetic"
  purchaseDate: string | null
  warehouseName?: string | null
  warehouseNumber?: string | null
  onlineOrderNumber?: string | null
}
```

Important:
- Do not export a real warehouse barcode unless analytics specifically needs it. Version 1 does not.
- Do not export auth/session data.
- Synthetic identifiers may be used internally for stable linking if needed, but should be clearly marked synthetic.

## Purchased item

```ts
type AnalyticsItemV1 = {
  id: string
  purchaseId: string
  itemNumber: string | null
  description: string
  quantity: number | null
  unitPriceCents: number | null
  lineTotalCents: number | null
}
```

## Return

```ts
type AnalyticsReturnV1 = {
  id: string
  itemNumber: string | null
  returnDate?: string | null
  quantity: number | null
  amountCents?: number | null
  sourcePurchaseId?: string | null
}
```

`sourcePurchaseId` MUST be null/absent unless CostcoTracker actually knows the exact relationship.

## Price adjustment

```ts
type AnalyticsPriceAdjustmentV1 = {
  id: string
  itemNumber: string | null
  adjustmentDate?: string | null
  amountCents: number | null
  sourcePurchaseId?: string | null
}
```

Only include actual recorded adjustments in this collection.

## Validation requirements

The website must:
- verify `format`
- verify supported `formatVersion`
- validate arrays and field types
- reject malformed money/date fields that would corrupt analytics
- report validation errors without exposing unnecessary raw data
- ignore safe unknown fields for forward compatibility where appropriate

## Privacy exclusions

Never include:
- Costco login credentials
- cookies
- bearer tokens
- session storage
- payment card data
- full account profile
- return photos
- unrelated app preferences
- SideStore data
- device identifiers
