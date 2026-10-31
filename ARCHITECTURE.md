# Architecture

Vite + React + TypeScript + Tailwind single-page app, plus a small API (`server/`) that runs as Cloudflare Pages Functions over D1. The cloud design (D1 schema, auth, sync protocol, free-tier budget) is in **`docs/CLOUD_ARCHITECTURE.md`**. No telemetry.

The UI has two modes:
- **Cloud** (default): owner sign-in, plus management of iPhones, sync, import and backup against the same-origin API.
- **File on this device**: the original local viewer, kept in `LocalFileApp`.

The production build sets a Content-Security-Policy of `connect-src 'self'`, so the browser itself blocks any request to another origin.

## Layers

```
src/
  domain/            Pure, framework-free logic (no DOM, storage, or network)
    export/v1.ts       Zod schema + types for Analytics Export V1 (the contract)
    import/            Importer: text/value -> validated, normalized data or a structured error
    dataset.ts         LoadedDataset = validated export + app-generated import metadata
    summary.ts         Record counts shown after import (not analytics)
    sync/              Sync protocol schemas, canonical hashing, reconciliation planning (shared with server)
  persistence/       IndexedDB storage for the local-file mode (D1 is canonical in cloud mode)
  app/               React hook orchestrating local import / remember / forget
  cloud/             Typed same-origin API client, session hook, upload and backup workflows
  ui/                Presentational components; no calculations
    cloud/             Cloud screens: sign-in, overview, sync, iPhones, import, backup
  fixtures/          Synthetic data only
  test/              Test setup and fixture helpers
server/              Portable API handler (auth, sync, export) over a 4-method SQL interface
  adapters/            d1.ts (Cloudflare) and nodeSqlite.ts (tests / self-hosting)
functions/api/       Cloudflare Pages Function entry (the only Cloudflare-specific file)
migrations/          D1 / SQLite schema
```

Dependencies point inward: `ui -> app -> persistence -> domain` and `server -> domain`. Later analytics belong in `src/domain/` as pure, tested functions.

## Import pipeline (`src/domain/import/importExport.ts`)

1. Size guard (50 MB).
2. `JSON.parse`. The engine's error is discarded because it can quote file contents.
3. Envelope sniffing: `format` must be `costcotracker-analytics`, and `formatVersion` must be a supported integer. Each failure gets its own message: wrong file, missing version, newer version, or older version.
4. Zod V1 schema (`src/domain/export/v1.ts`), aligned field-for-field with the iOS SQLite tables (see `ANALYTICS_DATA_CONTRACT.md`):
   - Money must be safe-integer cents. Magnitude amounts must be `>= 0`; transaction totals are signed.
   - Dates must be real `YYYY-MM-DD` calendar dates, and `exportedAt` must be a zoned ISO timestamp.
   - Quantities must be finite and `> 0`, but need not be integers.
   - Every field is required. Unknown values are `null`, never `""`. Only `sourcePurchaseId` may be omitted.
   - `sourceType` and `identifierKind` must be a valid combination.
   - There are no barcode or order-number fields.
5. Integrity checks:
   - unique IDs per collection;
   - every `items[].purchaseId` resolves, and an explicit `sourcePurchaseId` resolves. Missing links stay `null` and are never inferred;
   - a whole-cent unit price agrees with the line total (±1 cent);
   - return/adjustment `transactionId`s never equal a receipt ID;
   - `(transactionId, itemNumber)` is unique, mirroring the iOS `UNIQUE` constraint;
   - rows that share a transaction agree on date, warehouse, type and total.
6. Warnings list the *names* of unknown fields. Unknown fields are stripped and their values are never kept.

Errors report a path such as `items[3].unitPriceCents` and a message. They never include the offending value. At most 50 issues are listed, together with the total count.

Normalization only converts an omitted `sourcePurchaseId` to `null`. No value is defaulted, guessed or derived.

## Persistence (`src/persistence/datasetStore.ts`)

- Off by default. The user opts in with "Remember this dataset on this device".
- One record under a fixed key, with a versioned record layout (`storageVersion`).
- Saved data is re-validated by the same importer on load. A damaged or incompatible record is reported, never patched.
- Importing without "remember" deletes any previously saved dataset, so stale data is not left behind.
- "Forget imported data" clears memory and deletes the entire IndexedDB database, which covers any future derived caches stored there.
- Without IndexedDB (some private modes), the app works in memory only and the option is disabled.
