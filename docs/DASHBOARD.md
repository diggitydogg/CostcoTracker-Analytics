# Analytics dashboard

`src/ui/dashboard/` is the main data-exploration experience. The same `Dashboard` component serves both data sources:

- **Cloud:** the **Dashboard** tab (the landing view after sign-in). `CloudDashboard` loads the full dataset once with `fetchCloudDataset`: `/api/export/meta`, then one request per page of each collection. It never makes per-record requests. The management screens (Overview, Sync, iPhones, Import, Backup) are unchanged.
- **File on this device:** the **Dashboard** view, shown first after an import.

## Data flow

```
AnalyticsExportV1 ─► Dashboard ─ useMemo ─► buildAnalyticsSnapshot(data, { source, categoryOverrides })
                                                  │  (one snapshot per dataset + overrides)
                                                  ▼
                       DashboardContext { snapshot, lookups, open(drill), overrides, today }
                                                  ▼
                Overview · Items · Price index · Categories · Returns & adjustments · Warehouses
                                    + drill-down drawer
```

- **No calculations in components.** Sections only format engine output.
- **Period totals and item queries** are in `derive.ts`. They are pure and tested:
  - Period totals are sums of the engine's own monthly buckets, so they reconcile exactly. "Last 12 months" equals `rolling12`, and a full year equals `yearly`.
  - Item queries are filtered and sorted views of `items`.
- **Category trends** come from the engine's `categoryTrends`.
- **Lookups** are ID → row maps (lines, returns, adjustments, receipt → warehouse label). They are built once per snapshot and used for drill-down.

## As-of date

- Every figure uses the engine's default as-of date: the **latest date in the dataset**. This covers rolling 12 months, "recent" items, cohorts and dormancy. All widgets therefore agree, and results are reproducible.
- The header states it: "figures as of …".
- Only the item detail's "Since latest purchase (as of today)" uses today's date, and it is labelled that way.

## Sections
| Section | Shows |
|---|---|
| **Overview** | Six summary cards with a time-period switch (all time, last 12 months, latest full year), comparisons only where the engine says the earlier period is comparable; monthly spending chart (purchases up; returns and adjustments down; optional net line; 12/24 months or all time; zero months drawn); trips; largest purchases; warehouse vs online; "About these numbers" |
| **Items** | Searchable (description variants or item number), filterable (staples, occasional, one-and-done, dormant staples, recent, category) and sortable explorer; missing values sort last |
| **Item detail** (drawer) | Stats, purchase pattern, category with override control, recorded-price history chart (same-day observations combined, with min–max whisker), price summary and volatility, purchases, returns, adjustments |
| **Price index** | "Your Costco price index": the weighted personal-basket index leads and the simple matched-item index is context; yearly or monthly view; confidence badges (Reliable / Low coverage / Insufficient data) on every figure; hollow points and dashed segments where the chain is not reliable; matched items and spend coverage; drill-down to each link's matched items. Never presented as CPI |
| **Categories** | Spend and share by category, subcategories, top items, yearly composition trend, Uncategorized items with a path to override them |
| **Returns & adjustments** | Totals, monthly charts, top items, "Returns as % of observed spend" and "Price adjustments as % of observed spend"; states that purchase-linked rates and time-to-return are not available |
| **Warehouses** | Channel cards, spend by location, table with placeholder, unknown, online and synthetic badges; only case/spacing variants are merged (by the engine) |

## Drill-down

- **What can be opened:** chart months, table rows, locations, price-index links and largest purchases all open a drawer of underlying records. Records are addressed by the opaque IDs the engine attached.
- **Navigating:** from those records you can open a purchase (its item lines) or an item. **Back** walks the stack, and **Escape** or the backdrop closes it.
- **What is shown:** only opaque IDs reach the UI. The export contains no barcodes or order numbers, and none are shown.

## Category overrides

- **Effect:** choosing a category in the item drawer stores `itemNumber → { categoryId, subcategoryId }`. The engine applies it on the next snapshot. Records are never modified.
- **Labels:** the item shows **Set manually** in the drawer and **Manual** in tables. **Use automatic category** removes the override.
- **Persistence:** overrides are kept in **this browser's IndexedDB** (`src/persistence/overridesStore.ts`).
  - They use the app's single database (`appDb.ts`, upgraded to version 2 with a `settings` store), so **Forget imported data** removes them too.
  - They are stored in the engine's versioned overrides-file format and validated on load.
  - They apply to both cloud and local data in the same browser.
  - They are never uploaded. There is no D1 schema change.
- **Without IndexedDB:** overrides apply to the current tab only, and the UI says so.

## Charts

- **Implementation:** charts are small hand-written SVG components (`charts/`). There is no chart dependency: they add no bundle weight, need no inline styles beyond CSSOM width/color (allowed by the CSP) and render in tests.
- **Sizing:** a ResizeObserver hook draws each chart at its real width.
- **Reading values:**
  - Hover, tap or the arrow keys select a column or point.
  - A readout above the plot shows every series' exact value.
  - Enter or a second tap opens the records.
- **Labels and legend:** every chart has a legend and an accessible label.
- **Colors:** the first three validated categorical slots (blue, orange, aqua) plus neutral ink. Confidence badges carry an icon and a label, never color alone.
- **Empty or sparse data:** handled with explicit messages.
- **Missing values:** they break lines rather than being interpolated.

## Responsive layout

- The page container grows to 100rem. The dashboard uses the full width, and management screens keep a 5xl reading width.
- **Summary cards:** 1 column on phones, 2 from 420px, 3 at `lg`, 6 at `2xl`.
- **Panels:** 1 column on phones, 2 at `lg`, 3 at `2xl` where useful.
- **Tables:** they keep their columns and scroll sideways inside a labelled region.
- **Drawer:** a side panel up to 48rem wide, full screen on phones.
- **Tested widths:** 375 px (no horizontal page overflow), 820 px and 1440 px.

## Deferred
- Dark mode (the app has none yet).
- Export/import of overrides as a file (the engine format exists).
- Syncing overrides to D1.
- AI-suggested categories.
- Per-chart table views beyond the readout and the existing tables.
- Caching snapshots in IndexedDB. Rebuilding is fast at today's size.
