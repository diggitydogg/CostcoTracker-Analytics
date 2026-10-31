# CostcoTracker Analytics — Product Specification

## Product purpose

CostcoTracker Analytics is a separate web application that analyzes receipt and purchase-history data exported by the CostcoTracker iOS app.

The iOS app handles collection/sync/storage. The web app handles exploration, visualization, categorization, and long-term analytics.

Version 1 is local-first and should not require a backend.

## Primary user workflow

1. User opens CostcoTracker Analytics.
2. User selects or drags in a CostcoTracker analytics JSON export.
3. App validates the file.
4. App parses and normalizes the dataset locally.
5. User may optionally choose to remember the imported dataset on this browser/device.
6. Dashboard becomes available.
7. Clicking aggregate metrics reveals the underlying transactions.
8. User can remove all imported data from the browser.

## First-release navigation

### Overview
Key cards:
- gross purchase spend
- net spend if reliably derivable
- total trips/orders
- average basket
- items/units purchased
- unique item numbers
- returned quantity/value where supported
- recorded price-adjustment savings
- warehouse vs online spend

Charts / insights:
- monthly spend
- spend by source
- top categories
- top repeat items
- biggest purchases
- recent trend

### Spending
- monthly spend
- annual spend / year-over-year
- average basket over time
- visit/order frequency
- spending by weekday
- gross vs returns/adjustments where semantics permit
- drill-down into underlying receipts/items

### Items
Searchable item explorer.

Per item:
- item number
- descriptions seen
- category/subcategory
- total spent
- number of purchases
- total quantity
- average unit price
- lowest unit price
- highest unit price
- latest unit price
- first/last purchase
- price-history chart
- purchase cadence
- underlying purchase rows
- returns and recorded adjustments where applicable

### Categories
- spend by category
- units by category
- category trends over time
- top items within category
- manual category correction/override
- uncategorized queue

Initial taxonomy:
- Groceries
- Meat & Seafood
- Produce
- Dairy & Refrigerated
- Snacks
- Beverages
- Household
- Cleaning
- Personal Care
- Clothing
- Electronics
- Home & Kitchen
- Home Improvement
- Furniture
- Seasonal
- Pet
- Automotive
- Health & Pharmacy
- Other
- Uncategorized

Support subcategories.

### Returns
Only report what the dataset actually supports.

Potential metrics:
- returned quantity
- return value if explicitly available/derivable
- return rate by item/category
- most-returned items
- timing trends

Never claim a particular returned unit maps to a particular historical purchase unless that relationship is explicit.

### Price Adjustments
Distinguish actual recorded adjustments from price-match opportunities.

Version 1 analytics should prefer actual recorded adjustments.

Metrics:
- total recorded savings
- count
- average
- largest
- by item
- by category
- over time

### Warehouses / Sources
- spend by warehouse/source
- visit count
- average basket
- unique items
- online vs warehouse
- price history by warehouse where useful

## Fun / derived analytics backlog

### Personal Costco Inflation Index
Use a stable basket of repeatedly purchased items to estimate how the user's own Costco prices have changed over time.

Requirements:
- methodology visible to user
- minimum repeat-purchase threshold
- avoid overstating precision
- let user inspect included items

### Price volatility
For repeat items:
- min / max / median
- simple normalized volatility measure
- frequency of price changes
- identify items that frequently fluctuate

### Purchase cadence
For repeat items:
- median interval between purchases
- mean interval
- last purchase
- "typically purchased every N days"

Do not claim this predicts consumption or inventory.

### Shopping behavior
Examples:
- biggest trip/order
- smallest trip/order
- longest gap between trips
- busiest month
- most frequently visited warehouse
- most purchased item
- most spent-on item
- long-running staples
- one-and-done items
- new items this year
- items no longer purchased recently

## Traceability requirement

Every aggregate must retain enough provenance to answer:

> Which source rows produced this number?

Examples:
- Click monthly spend → list receipts/orders/items included.
- Click category spend → list category items and transactions.
- Click a return metric → show return records included.

Prefer stable row IDs from import data. If an ID is absent, create an internal deterministic ID during import but do not pretend it came from CostcoTracker.

## Date and money rules

- Treat exported date-only purchase dates as calendar dates, not moments in UTC.
- Avoid timezone shifts that change the purchase day.
- Prefer integer cents internally for money aggregation.
- Preserve source currency metadata if/when added.

## Quantity / unit price

Do not assume quantity is always an integer.

If unit price is not explicitly supplied but can be reliably computed:
- document formula
- handle zero/missing quantity
- preserve source amount separately

## Categories

Version 1 should support:
- deterministic local rules for obvious classifications
- user overrides
- uncategorized items
- import/export of category overrides

Future optional AI classification:
- only send minimal product identity information
- ideally item number + description
- no receipt date, warehouse, purchase price, order ID, barcode, or account/session data
- user must be able to review/override

## Non-goals for version 1

- Costco login
- Costco scraping
- server-side receipt storage
- multi-user accounts
- social features
- automatic financial advice
- inventory/consumption claims
- exact return-to-purchase matching when not supported
- tax/accounting claims

## Quality bar

- No unexplained metrics
- No fake data in production code
- Synthetic fixtures for tests/demo mode
- Good empty states
- Import errors are actionable
- Responsive layout
- Keyboard accessible
- Charts have textual/table alternatives where practical
- No console errors
- Tests for core analytics math
- Production build succeeds
