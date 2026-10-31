# CLAUDE.md

## Project

CostcoTracker Analytics is the local-first web analytics companion to the iOS app CostcoTracker.

The iOS app is the source of truth for collected receipt/order data. This web app analyzes an exported, versioned JSON dataset. It must not scrape Costco, require Costco credentials, or require a remote database for version 1.

## Core principles

1. **Local-first privacy**
   - Do not upload raw receipt, item, return, warehouse, order, or adjustment data to a remote service by default.
   - Imported analytics data stays in browser memory and/or IndexedDB.
   - No tracking/analytics SDKs in version 1.

2. **Traceability**
   - Every aggregate number must be drillable to the underlying rows used to compute it.
   - Never show unexplained totals that cannot be reconciled.

3. **Honest data semantics**
   - Do not infer a specific return-to-purchase relationship unless the imported data explicitly provides one.
   - Do not invent quantities, dates, warehouses, prices, categories, or item identity.
   - Missing data must remain missing.

4. **Deterministic analytics**
   - Core metrics must be calculated by pure/tested functions, not by an LLM.
   - AI may later help categorize unknown products, but category classification must be optional, reviewable, and persistently overrideable.

5. **Versioned import**
   - All imported datasets must declare a format version.
   - Reject unsupported/corrupt input with a useful message.
   - Never silently coerce materially invalid data.

6. **Responsive UI**
   - Desktop is the primary experience.
   - Must remain usable at 320px wide and on tablets.
   - Avoid fixed screen-size assumptions.

## Preferred stack

Unless there is a strong technical reason to change it:

- Vite
- React
- TypeScript
- Tailwind CSS
- ECharts or Recharts
- Zod
- IndexedDB via a small well-maintained wrapper or a minimal local abstraction
- Vitest
- React Testing Library where useful

Do not add a server framework merely for convenience.

## Security / privacy

Never commit:
- real Costco receipt data
- real order numbers
- real receipt barcodes
- auth cookies/tokens
- Costco account credentials
- user-specific personal purchase datasets
- `.env` files with secrets

Use synthetic fixtures only.

## Source terminology

Use these concepts consistently:

- `receipt` — warehouse receipt record
- `order` — online order when represented in export
- `item` — purchased line item
- `itemNumber` — Costco item number where available
- `return` — recorded returned quantity/value data
- `priceAdjustment` — recorded actual adjustment, not merely an opportunity
- `warehouse` — source warehouse/store metadata
- `categoryOverride` — user-selected category assignment

## Verification

Before finishing any task:

1. Run formatting/linting if configured.
2. Run unit tests.
3. Run build.
4. Report any warnings.
5. Do not merge your own PR.
6. Keep the change bounded to the assigned task.

## Git / cloud task behavior

Cloud tasks should:
- work on their own branch
- create a focused PR
- explain files changed
- explain design decisions
- list tests run
- call out assumptions or unresolved questions

Do not rewrite unrelated files simply for style.
