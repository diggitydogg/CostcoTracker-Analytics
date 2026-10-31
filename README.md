# CostcoTracker Analytics

A local-first analytics companion for CostcoTracker.

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

Version 1 is local-first:

- No account required
- No remote database required
- No receipt data uploaded to a server by default
- Imported data may be stored in IndexedDB on the current browser/device
- A clear "Forget imported data" action must remove locally persisted data

See `PRIVACY.md`.

## Development

Read these first:

- `CLAUDE.md`
- `PROJECT_SPEC.md`
- `ANALYTICS_DATA_CONTRACT.md`
- `PRIVACY.md`

The `cloud-tasks/` directory contains bounded tasks intended to run as separate Claude Code cloud sessions / pull requests.

## License

MIT
