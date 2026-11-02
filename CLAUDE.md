# CLAUDE.md

## Project

CostcoTracker Analytics is the privacy-first web analytics companion to the iOS app CostcoTracker.

The iOS app is the source of truth for collected receipt/order data. This web app analyzes a versioned dataset, synced from the app into the owner's own Cloudflare D1 database or imported as a JSON export. It must not scrape Costco, and it must never receive or store Costco credentials. The complete personal-use app must run at $0/month on free tiers (`docs/CLOUD_ARCHITECTURE.md`).

## Core principles

1. **Owner-controlled privacy**
   - Analytics data may be stored only in the owner's own deployment (Cloudflare D1) and in browser memory/IndexedDB. Never send it to any other service, except as allowed by the bounded product-identification exception below.
   - **Product-identification exception (the only one).** To identify a product, the app may send a third-party web search provider ONLY:
     - the Costco item number;
     - the abbreviated receipt description, or generic product text (e.g. text read from a product photo).

     It must NEVER send:
     - receipt/order IDs, order numbers or barcodes;
     - dates or warehouse/location;
     - prices, spend or quantities;
     - purchase history;
     - account, session or device information.

     The feature must stay optional and owner-triggered, with no automatic or background lookups. Its request schema must be strict, so any other field is rejected. Search results may be stored only as far as the provider's terms explicitly allow.
   - Never store Costco cookies/passwords/tokens, receipt barcodes, or order numbers in the cloud.
   - No tracking/analytics SDKs.
   - No feature may require a paid tier; anything that could must be optional and documented.

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
- Cloudflare Pages + Pages Functions + D1 (free plan), behind the portable `server/` handler
- IndexedDB via a small well-maintained wrapper or a minimal local abstraction
- Vitest
- React Testing Library where useful

Do not add a server framework merely for convenience; keep Cloudflare-specific code confined to `functions/` and `server/adapters/d1.ts`.

## Security / privacy

Never commit:
- real Costco receipt data
- real order numbers
- real receipt barcodes
- auth cookies/tokens
- Costco account credentials
- user-specific personal purchase datasets
- `.env` files with secrets
- `.dev.vars`, owner access keys, device tokens, the `idKey`, or D1 SQL dumps

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
