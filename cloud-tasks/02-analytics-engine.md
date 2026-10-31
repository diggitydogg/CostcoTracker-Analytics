# Cloud Task 02 — Analytics Engine

Build a pure, well-tested analytics layer. Read all root docs first.

Deliverables:

Spending:
- gross purchase spend
- spend by month/year/source
- warehouse vs online
- average basket
- trip/order count

Items:
- unique item count
- purchase count
- total quantity/spend
- average/min/max/latest unit price
- first/last purchase
- price history
- repeat-purchase intervals
- mean/median cadence

Returns:
- only metrics supported by source data
- do not infer exact purchase linkage

Adjustments:
- total actual recorded savings
- count/average/max
- by month/item

Warehouses/sources:
- visits/orders
- spend
- average basket
- unique items

Fun deterministic helpers:
- biggest/smallest trip
- longest gap
- busiest month
- most frequently purchased item
- highest total-spend item
- one-and-done candidates
- long-running staples

Requirements:
- integer cents for money
- provenance/source IDs retained for aggregates
- synthetic fixtures covering multiple years, sources, fractional quantity, missing fields, price changes, unlinked returns, adjustments
- exact tests

Out of scope: UI/charts, AI classification, backend, scraping.

Create a focused PR and document formulas/tests/build.
