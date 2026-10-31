# CostcoTracker Analytics

A privacy-first, free-to-run analytics companion for CostcoTracker.

CostcoTracker Analytics turns exported CostcoTracker purchase history into useful, explorable spending and product analytics without requiring a cloud database or user account.

## Goals

- Keep raw receipt/purchase data local to the user's browser by default.
- Make every aggregate number traceable back to the receipt/item rows that produced it.
- Analyze spending, categories, repeat purchases, price history, returns, price adjustments, warehouses, and shopping patterns.
- Be useful on desktop first, while remaining responsive on phones and tablets.
- Avoid pretending inferred relationships are known facts.

## Planned first release

- Import a versioned CostcoTracker analytics export (`.json`)
- Validate and store the imported dataset locally
- Overview dashboard
- Spending analytics
- Item explorer and personal price history
- Category analytics
- Return analytics
- Price-adjustment analytics
- Warehouse analytics
- Drill-down from aggregate metrics to underlying transactions
- Export/import of user category overrides

## Privacy model

- Single owner. No public accounts.
- Data is synced from CostcoTracker iOS into the owner's own Cloudflare D1 database, on the free plan.
- Costco credentials never leave the phone. Barcodes and order numbers are never uploaded.
- No trackers or third-party data sharing.
- JSON export and import provide backup and portability.

See `PRIVACY.md` and `docs/CLOUD_ARCHITECTURE.md`.

## Development

Read these first:

- `CLAUDE.md`
- `PROJECT_SPEC.md`
- `ANALYTICS_DATA_CONTRACT.md`
- `PRIVACY.md`

Requires Node.js 20.19+ (22 LTS recommended).

```bash
npm install
npm run dev        # local dev server
npm test           # unit + component tests (Vitest)
npm run lint       # ESLint
npm run build      # type-check and production build
```

Cloud API (local, no Cloudflare account needed):

```bash
npm run auth:generate-key   # put the printed digest in .dev.vars (see .dev.vars.example)
npm run db:migrate:local    # create the local D1 database
npm run dev:cloud           # SPA + /api/* on http://localhost:8788
```

See `ARCHITECTURE.md` for code layout and `docs/CLOUD_ARCHITECTURE.md` for the cloud design.

The `cloud-tasks/` directory contains bounded tasks intended to run as separate Claude Code cloud sessions / pull requests.

## License

MIT
