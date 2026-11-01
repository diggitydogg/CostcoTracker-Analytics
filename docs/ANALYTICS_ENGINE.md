# Analytics engine

`src/analytics/` is a pure TypeScript engine. One call, `buildAnalyticsSnapshot(data, options)`, turns a validated **Analytics Export V1** dataset into one coherent snapshot. The engine has no React, no I/O and no clock.

## One dataset, two sources

```
local file   ─► importExportText ─────────────────────────────────┐
                                                                    ├─► AnalyticsExportV1 ─► buildAnalyticsSnapshot ─► AnalyticsSnapshot
cloud (D1)   ─► /api/export/meta + paged /api/export/* ─► importer ─┘        (src/cloud/cloudDataset.ts)
```

There is exactly one analytics implementation.

**Cloud data path** (`fetchCloudDataset`):
- It reuses the existing owner-authenticated export endpoints: one `meta` request, then one request per page of each collection (1,000 rows per page), never one per record. About 17 requests at 10× today's data.
- Pages are validated by the same importer as local files.
- Tombstoned records (no longer on the iPhone) are excluded, exactly as in backups. Their count is passed into data quality.
- The backup feature now uses the same loader.

**Where it runs.** Analytics run in the browser. The Worker has a 10 ms CPU budget and the dataset is small. At 10× the current real size (≈1,900 receipts, ≈15,000 item lines), generating, validating and analysing a test dataset plus all invariant checks takes about 0.6 s in tests.

**No backend changes.** No new API, no new fields, and no change to auth or CSRF. The engine only sees Export V1 fields: opaque IDs, item numbers, descriptions, quantities, cents, dates and warehouse strings. Barcodes, order numbers, device tokens and `idKey` never reach it.

## Layout

| File | Contents |
|---|---|
| `model.ts` | `buildIndex`: joins items to receipts once; purchase events and lines; the as-of date |
| `config.ts` | **All tunable thresholds** (`DEFAULT_THRESHOLDS`) |
| `spending.ts` | Gross, refunds, adjustments, net; monthly, yearly, rolling 12 months, year-over-year |
| `trips.ts` | Purchase events, baskets, intervals, weekday and month patterns |
| `items.ts` | Per-item statistics and cohorts |
| `prices.ts` | Per-item price history and volatility |
| `inflation.ts` | Personal inflation (matched-item and weighted basket) |
| `returns.ts`, `adjustments.ts` | Returns and price adjustments |
| `linkage.ts` | Whether returns/adjustments link to specific purchases (purchase-linked rate availability) |
| `warehouses.ts` | Warehouse and channel grouping |
| `categories/` | `taxonomy.ts` (data), `rules.ts` (data), `engine.ts` (matcher and overrides), `analytics.ts` (spend by category) |
| `quality.ts` | Coverage and limitations |
| `snapshot.ts`, `index.ts` | Public entry point |

**Conventions:**
- Money is always integer cents. Averages of cents are rounded to whole cents.
- Ratios and percentages are plain fractions (`0.05` = 5%).
- Anything undefined (empty input, zero denominator) is `null`, never NaN or Infinity. A test walks the whole snapshot to check this.

**Provenance:** every aggregate carries the IDs it was computed from (`receiptIds`, `returnIds`, `adjustmentIds`, `lineIds`, `itemNumbers`). This lets a dashboard drill down to rows.

**As-of date:** `options.asOf` sets the reference date for "days since" and rolling windows. It defaults to the latest date in the data, so results are deterministic. The UI can pass today's date instead.

## Spending

| Measure | Definition |
|---|---|
| **Gross purchase spend** | Σ `items.lineTotalCents`. A line total is the recorded net amount for the line after Costco instant savings. Pre-tax: the export has no tax or receipt totals. |
| **Refunds** | Σ `returns.merchandiseAmountCents`, only for returns that record it. Returns without it are counted (`returnsWithoutAmount`), never estimated. |
| **Price adjustments** | Σ `priceAdjustments.amountCents` (recorded savings). |
| **Net spend** | gross − refunds − price adjustments (exact identity, tested). |

**Never summed:** `transactionTotalCents` (returns and adjustments). It is the total of the whole transaction, including other lines and tax, and it repeats on every row of that transaction.

**Time attribution:**
- Purchases go by receipt date, refunds by return date, adjustments by adjustment date.
- Records without a date go to an explicit `undated` bucket. Σ months + undated = lifetime holds for every measure, and the same for years.

**Rolling and averages:**
- **Rolling 12 months:** the 12 calendar months ending at the as-of month. It is compared with the prior 12 months only when that whole window lies inside the data.
- **Average and median month:** over every calendar month from the first to the last dated purchase, with zero-spend months included.

**Year-over-year:** only between two complete calendar years (all 12 months inside the data span). Partial years are flagged `complete: false` and their change is `null`.

## Trips and orders
- **Purchase event:** one receipt or online order.
- **Basket:** Σ of the event's item line totals (an estimate, pre-tax). Events with no exported lines have no basket and are excluded from basket statistics; they are counted separately.
- **Intervals:** gaps between distinct dated shopping **days** (two receipts on one day count as one trip day). Reported as average, median and longest gap with its dates.
- **Weekday, month-of-year and busiest-month counts:** dated events only. Ties are listed.
- **WHSE_ caveat:** receipts with a synthesized `WHSE_` key may merge same-day trips (an iOS limitation), so counts are a lower bound. This is flagged in data quality.

## Items
Statistics are computed per `itemNumber`.

**Description and dates:**
- Description variants are listed most recent first. The display name is the latest one, normalized for whitespace only.
- First and last purchase date come from dated lines.

**Spend and quantity:**
- Purchase events are distinct receipts containing the item.
- Total quantity can be fractional. Total spend is Σ the item's line totals.

**Prices:**
- **Average unit price** = Σ(unit × qty) / Σ qty over lines with a **recorded** unit price. It is never derived from line total ÷ quantity.
- First, latest, min and max prices come from the price history.

**Cadence:** gaps in days between the item's distinct purchase days (mean and median).

**Returns and adjustments:** matched to the item by item number (count, quantity, recorded amount).

### Cohorts
Thresholds live in `config.ts`.

| Cohort | Rule (defaults) |
|---|---|
| `staple` | ≥ 4 purchase events across ≥ 3 distinct months, and not dormant |
| `dormant-staple` | Meets the staple bar but unbought for more than max(3 × median cadence, 120 days) |
| `occasional` | ≥ 2 purchase events but not a staple |
| `one-and-done` | Exactly 1 purchase event |
| `not-purchased` | Only seen in returns or adjustments (bought before the data) |
| `recent` (flag) | Last purchase within 30 days of the as-of date |

## Price history
- **Observations:** lines with a recorded `unitPriceCents` and a date. Lines without a unit price are counted (`unpricedLines`), never estimated. The iOS export leaves the unit price null exactly when it isn't a whole number of cents.
- **Daily points:** same-day observations (several lines, receipts, warehouse and online) collapse into one daily point at the quantity-weighted mean Σ(unit × qty) / Σ qty, rounded to cents. Each point keeps its min, max, count, quantity and sources.
- **First / latest / absolute and percent change:** first and last daily points. The percent change is `null` with fewer than 2 points or a zero first price.
- **Min / max:** over all observations. **Mean / median:** over daily points.
- **Volatility** = the coefficient of variation of daily point prices: population standard deviation ÷ mean. It is scale-free (0.10 ≈ prices typically 10% from their mean) and needs ≥ 3 points.
- **Change frequency:** the share of consecutive points whose price differs.
- **Biggest increase / decrease:** the largest cents step between consecutive points. Ties go to the larger relative change, then the later step.

## Personal Costco inflation

**Period price.** For each item i and period t (a calendar year or month):

```
p_i(t) = Σ(unit_price × qty) / Σ qty   over the item's priced, dated lines in t
s_i(t) = Σ lineTotalCents of those lines
```

**Links.** Consecutive periods present in the data form **links** (a → b). Only items priced in **both** periods are matched (M), and the relative is r_i = p_i(b) / p_i(a). Relatives outside [1/3, 3] are treated as pack-size or product changes under the same item number, and are excluded and counted.

- **(a) Simple matched-item inflation (Jevons):** L = geometric mean of r_i over M.
- **(b) Weighted personal-basket index (chained Törnqvist):**
  ```
  w_i = ½ ( s_i(a) / Σ_M s(a)  +  s_i(b) / Σ_M s(b) )
  L   = exp( Σ_M w_i · ln r_i )
  ```
  Expenditure shares from both periods handle a changing basket. It is computed only with ≥ 5 matched items.

**Index.** I(first) = 100 and I(b) = I(a) × L. A link with no usable matched items **breaks the chain**: later values are `null`, not guessed. Links that span gaps compare the two observed periods directly.

**Coverage and confidence.** Calculation availability is separate from confidence.
- Coverage = (Σ_M s(a) + Σ_M s(b)) / (all item spend in a and b).
- Each link's relatives and index values are reported whenever they are mathematically defined: Jevons with ≥ 1 matched item, Törnqvist with ≥ 5. A low confidence never hides the number.
- Each link also carries `matchedItems`, `spendCoverage` and a `confidence`:

| `confidence` | Rule (defaults in `config.ts`) |
|---|---|
| `insufficient` | Fewer than `inflationMinMatchedItems` (5) matched items, or no spend to measure coverage |
| `low-coverage` | Enough matched items, but coverage < `inflationReliableMinSpendCoverage` (**20%**) |
| `reliable` | ≥ 5 matched items **and** coverage ≥ 20% |

- A chained index is only as strong as its weakest link. Each period carries `chainConfidence`, the weakest confidence of the links leading to it.
- Series report `linksByConfidence` counts.

**Summary.**
- The latest year-over-year link.
- The cumulative change since the first year.
- The annualized rate: (1 + cumulative)^(1 / calendar years elapsed) − 1.
- `latestYearConfidence`: the confidence of the latest yearly link.
- `cumulativeConfidence`: the weakest yearly link, which applies to the cumulative and annualized figures.
- `reasons`: plain-language explanations (with counts and coverage) whenever confidence is below `reliable`.

**Limitations:**
- Unit prices are net of instant savings, so a sale lowers the observed price.
- Pack-size changes under one item number are only caught by the outlier guard.
- Unpriced lines aren't observed.
- Sparse monthly data often breaks the monthly chain, so the yearly view is the headline.
- This is a personal price-change estimate, not an official CPI.

## Returns
- **Totals:** count, quantity, recorded merchandise amount, returns without an amount, and distinct return transactions.
- **Breakdowns:** by month and year, with an undated bucket. Items are ranked by count and by amount.
- **Observed ratios, not return rates.** Returns are not linked to the purchase they came from (`sourcePurchaseId` is null). A return in the data may be for a purchase made before the data begins, so these are descriptive ratios over the observed dataset, not causal, purchase-linked return rates. They can exceed 100%.
  - **`observedReturnValueRatio`:** Σ recorded merchandise returned ÷ observed gross purchase spend. Dashboard label: "Returns as % of observed spend", never "Return rate".
  - **`observedUnitReturnRatio`:** returned quantity ÷ purchased quantity, over item numbers seen in both.
  - **Per item `observedUnitReturnRatio`:** returned ÷ purchased quantity, flagged when it exceeds 1 (proof of returns of purchases from before the data). It is `null` for items never purchased in the data.
- **`purchaseLinkedReturnRate`:** `{ available: false, linkedRecords, unlinkedRecords, reason }` unless **every** return has a `sourcePurchaseId` found in the data. Only then is it `available: true`, with `rate` = Σ linked return amounts ÷ Σ baskets of the linked purchases. Partial linkage stays unavailable. With today's exports it is always unavailable.
- **Time-to-return:** only for returns with an actual `sourcePurchaseId`. The iOS exporter always sends null, so it reports `available: false` with the reason. Nothing is inferred.

## Price adjustments
- **Totals:** count, total recovered, average, largest, by month and year, and items ranked by count and by amount.
- **Observed ratios, not savings rates.** Adjustments are not linked to the purchase they adjust (`sourcePurchaseId` is null):
  - **`observedAdjustmentValueRatio`:** Σ adjustments ÷ observed gross spend. Dashboard label: "Price adjustments as % of observed spend".
  - **`observedAdjustedItemsValueRatio`:** adjustments on item numbers purchased in the data ÷ observed spend on those item numbers.
  - **Per item `observedValueRatio`:** item adjustments ÷ item observed spend.
- **`purchaseLinkedSavingsRate`:** the same availability rule as for returns; unavailable with today's exports.
- `transactionTotalCents` is never summed.

## Warehouses and channels

**Grouping.** Receipts are grouped by channel (`sourceType`) plus the warehouse string, normalized **only** for case and whitespace. Different strings are never merged on a guess.

**Explicit kinds:**
- `unknown`: no warehouse.
- `placeholder`: the iOS placeholder `Warehouse`, meaning the name wasn't recorded.
- `online-fulfillment`: the online "Online Order (Fulfilling Whse #N)" strings.
- `synthetic`: test or demo data.

**Per group:**
- event count, spend (Σ baskets) and average basket;
- unique items, first and last date;
- the raw variants merged into the group;
- source receipt IDs.

**Channel summaries:** warehouse, online and synthetic, each with its share of spend.

## Categories
- **Taxonomy** (`categories/taxonomy.ts`):
  - Grocery, with subcategories Produce, Meat & Seafood, Dairy & Eggs, Frozen, Snacks, Beverages, Pantry and Bakery;
  - Household, Cleaning, Paper Goods, Personal Care, Health, Clothing, Electronics, Home, Seasonal, Automotive, Pet, Alcohol and Other;
  - an explicit Uncategorized fallback.
- **Rules** (`categories/rules.ts`) are pure data, separate from the matcher and from the analytics.
  - A description is upper-cased and split into alphanumeric tokens.
  - A rule phrase must appear as contiguous whole tokens; `*` marks a prefix token.
  - The first matching rule wins, so specific phrases ("PEANUT BUTTER", "HOT DOG*", "PAPER TOWEL*", "MILK CHOCOLATE") come before the generic words they contain.
- **Order of decision:** a user **override** by `itemNumber` first, then the rules (trying description variants most recent first), then Uncategorized. Each assignment records its source, rule ID and matched phrase, for explainability.
- **Overrides** live outside the purchase records, so changing one never alters historical data.
  - `withOverride` returns a new object.
  - `serializeCategoryOverrides` and `parseCategoryOverrides` define a validated, versioned JSON file (`costcotracker-category-overrides` v1) for a future review, import and export UI.
  - Overrides naming an unknown category or subcategory are ignored.
- **Future AI help** may only implement `CategorySuggester`, which receives item number and description only. Its results must be stored as overrides after review. Nothing calls a network service.
- **Spend:** Σ category spend = gross spend. Uncategorized item count and spend share are reported.

## Data quality

`snapshot.quality` reports:
- totals and the date range;
- receipts and lines without dates;
- receipts without items;
- lines without a unit price, with their share of spend;
- returns without an amount or date, and adjustments without a date;
- receipts by source, `WHSE_` receipts, and placeholder or unknown warehouses;
- the uncategorized share;
- items returned in excess of purchases;
- inflation link counts by confidence and the latest yearly confidence;
- tombstoned cloud records that were excluded.

`limitations[]` holds plain-language notes that apply to **this** dataset only.

## Tests
`src/analytics/**/*.test.ts` covers the following with deterministic synthetic data:
- **Money and attribution:** exact money totals, no double counting of transaction totals, fractional quantities, missing prices, and same-day observations.
- **Items:** cohorts, returns, adjustments, and warehouse grouping.
- **Categories:** a broad table of realistic synthetic descriptions plus precedence traps.
- **Inflation:** exact Jevons and Törnqvist values, sparse-data refusal, chain breaks and annualization.
- **Prices and quality:** volatility and data-quality notes.

`invariants.test.ts` checks every reconciliation identity and that no value is NaN or Infinity. It runs on generated multi-year datasets at real and 10× scale, on edge cases and on the bundled fixture. A UI test checks that the cloud path (real API handler) and the local path give the same numbers.

## What the dashboard PR still needs
- **Charts:** monthly spend, price history and the inflation series, with drill-down using the IDs each aggregate already carries.
- **Category overrides:** a review and override UI, persisted (IndexedDB locally; D1 if overrides should sync) and wired to `categoryOverrides`.
- **As-of date:** choose between "today" and "latest data" for `asOf`.
- **Caching:** an IndexedDB snapshot or dataset cache if loading time ever matters.
