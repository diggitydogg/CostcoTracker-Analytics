# Cloud Architecture: free-first, Cloudflare-backed

Status: **foundation and owner management UI implemented**.

| Built | Not yet built |
|---|---|
| D1 schema and migration | IndexedDB delta cache (§7). It isn't needed by the management UI, which reads the API directly |
| All API endpoints in §4, §5, §7 and §10 | iOS exporter and sync client (CostcoTracker repo) |
| Shared protocol, hashing and reconciliation (`src/domain/sync/`) | Analytics dashboard |
| D1 and node:sqlite adapters; local dev via wrangler | |
| Owner UI: sign-in, overview, iPhones (enrollment and revocation), sync requests and history (including removal review), file import via the sync protocol, validated backup download (`src/cloud/`, `src/ui/cloud/`) | |

## 0. Goals and hard constraints

| # | Requirement | How it is met |
|---|---|---|
| H | $0/month indefinitely for normal personal use | Cloudflare Pages + Pages Functions (Workers runtime) + D1, all on the Free plan. Budgets are in §8. No feature depends on a paid tier. |
| 1 | Durable cloud store | D1 is canonical (§2). IndexedDB becomes a read-through cache (§7). |
| 2–4 | Idempotent sync, reconciliation, history | Run → batches → complete protocol, plus content hashes and a sync history table (§5, §6). |
| 5 | Website-triggered sync | A sync-request queue that the iOS app polls (§7). |
| 6–7 | Single-user auth, device enrollment | An owner access key gives a web session. One-time enrollment codes give revocable device tokens (§4). |
| 8 | No Costco credentials in the cloud | Sync payloads are schema-allowlisted, and secret-like field names are rejected (§9). |
| 9 | JSON import as bootstrap/DR | The browser validates with the existing importer, then uploads through the same sync protocol (§5.6). |
| 10 | Full export | Paginated `GET /api/export/*`. The browser reassembles Export V1 and re-validates it with the importer (§10). |
| 12 | Self-hosting path | Portable `fetch` handler, a small DB interface (D1 and node:sqlite adapters), and SQLite-dialect SQL (§13). |

### Changes to the version-1 principles
`CLAUDE.md` and `PRIVACY.md` described a local-only v1. This design deliberately changes that. Purchase analytics data is now stored at a third party (Cloudflare) under the owner's own account. The privacy model in §9 states exactly what is stored and what is never stored.

What stays the same:
- no tracking or analytics SDKs;
- no data sent to any other party;
- no Costco credentials anywhere off the device;
- every number traceable to source rows;
- no inferred return-to-purchase links.

## 1. Topology

```
┌──────────────┐   HTTPS, device bearer token    ┌───────────────────────────────┐
│ CostcoTracker│ ──────────────────────────────▶ │ Cloudflare Pages project       │
│ iOS (on-device│  /api/device/*, /api/sync/*    │  • static SPA (dist/)  — free  │
│ Costco login) │ ◀── sync-request polling ───── │  • Pages Functions /api/*      │
└──────────────┘                                 │    (Workers runtime)           │
                                                 │        │ D1 binding "DB"       │
┌──────────────┐   HTTPS, same-origin cookie     │        ▼                       │
│ Browser SPA  │ ──────────────────────────────▶ │  D1 (SQLite) — canonical store │
│ + IndexedDB  │   /api/auth/*, /api/export/*…   └───────────────────────────────┘
│   cache      │
└──────────────┘
```

**Why Pages Functions rather than a separate Worker.** They run on the same Workers runtime and the same free plan, but the SPA and the API share one origin. That allows a `SameSite=Strict` session cookie, needs no CORS, and keeps the CSP at `connect-src 'self'`. Static-asset requests are free and unlimited, and `_routes.json` limits Function invocations to `/api/*`.

**Code layout.**
- `functions/api/[[route]].ts` is the only Cloudflare-specific entry file.
- It wraps `server/app.ts`, a plain `(Request) => Promise<Response>` handler.
- The handler is built on `server/db.ts`, a four-method DB interface with D1 and node:sqlite adapters.
- Validation, hashing and reconciliation planning are pure functions in `src/domain/sync/`, shared with the browser.

## 2. D1 schema (`migrations/0001_initial.sql`)

### General rules
- **Money** is stored as INTEGER cents.
- **Dates** are TEXT `YYYY-MM-DD`; timestamps are ISO-8601 UTC TEXT.
- **Booleans** are INTEGER 0/1.
- **No SQLite-only features** beyond `ON CONFLICT … DO UPDATE` and `CHECK`. Both also exist in Postgres.

### Analytics tables
These mirror Export V1 one-to-one.

| Table | Key columns | Notes |
|---|---|---|
| `receipts` | `id` PK (export ID `r_…`), `source_type`, `identifier_kind`, `purchase_date`, `warehouse` | `bundle_hash` is the SHA-256 of the receipt together with all of its items, in canonical form. |
| `items` | `id` PK (`i_…`), `receipt_id` FK → receipts ON DELETE CASCADE, `item_number`, `description`, `quantity` REAL, `line_total_cents`, `unit_price_cents` NULL | Replaced as a set per receipt bundle (§6). |
| `item_returns` | `id` PK (`ret_…`), `transaction_id`, `item_number`, `return_date`, `warehouse`, `quantity`, `description`, `transaction_type`, `merchandise_amount_cents`, `transaction_total_cents`, `source_purchase_id` NULL FK → receipts | `UNIQUE(transaction_id, item_number)`. `content_hash`. |
| `price_adjustments` | `id` PK (`adj_…`), `transaction_id`, `item_number`, `adjustment_date`, `warehouse`, `amount_cents`, `adjusted_quantity`, `reference_line_numbers` (JSON array TEXT), `transaction_type`, `transaction_total_cents`, `source_purchase_id` NULL FK | `UNIQUE(transaction_id, item_number)`. `content_hash`. |

The three record tables with their own lifecycle (`receipts`, `item_returns`, `price_adjustments`) also carry reconciliation and provenance columns. Items inherit these through their receipt.
- `first_seen_run_id`, `last_changed_run_id`
- `missing_since_run_id` NULL: set when a reviewed full sync no longer contains the row. It is a tombstone, never a hard delete.
- `change_seq` INTEGER: global, monotonic, and drives delta fetches (§7).
- `created_at`, `updated_at`

### Operational tables

| Table | Purpose |
|---|---|
| `devices` | `id`, `name`, `token_sha256` UNIQUE, `created_at`, `last_seen_at`, `revoked_at` |
| `enrollment_codes` | `code_sha256` PK, `expires_at`, `used_at`, `device_id`. One-time use, 10-minute TTL. |
| `sessions` | `token_sha256` PK, `created_at`, `expires_at`, `last_used_at` |
| `auth_failures` | `occurred_at`, `kind`. Global throttle; no IP addresses stored (§4.4). |
| `sync_runs` | `id` (client UUID), `device_id` NULL, `source` (`ios`/`web-import`), `mode` (`incremental`/`full`), `status` (`open`/`completed`/`needs_review`/`aborted`/`abandoned`), `format_version`, `request_id` NULL, timestamps, counters (inserted/updated/unchanged/revived per kind, `marked_missing`), `error_code` |
| `sync_batches` | PK `(run_id, seq)`, `payload_sha256`, `result_json`, `change_seq` UNIQUE, `received_at` |
| `sync_requests` | `id`, `requested_at`, `status` (`pending`/`acknowledged`/`fulfilled`/`expired`), `acknowledged_at`, `acknowledged_by_device_id`, `fulfilled_run_id` |
| `instance_settings` | `key` PK, `value`. Holds `id_key` (§3) and `schema_version`. |

## 3. Export IDs: refined for multi-device, reinstall-safe sync

Contract V1 kept IDs opaque. Sync needs them to be **deterministic across reinstalls and devices**, otherwise a reinstall would duplicate every record. The contract now specifies:

| Record | ID |
|---|---|
| receipt | `r_` + token("receipt", receipts.barcode) |
| item | `i_` + token("item", receipt_barcode ⟂ item_number ⟂ occurrence) — `occurrence` = 0-based index among same item number in that receipt, ordered by SQLite rowid |
| return | `ret_` + token("return", transaction_barcode ⟂ item_number) |
| adjustment | `adj_` + token("adjustment", transaction_barcode ⟂ item_number) |
| transaction | `t_` + token("transaction", transaction_barcode) |

`token(d, v) = base64url(HMAC-SHA256(idKey, d ⟂ v))[0..22]`, where ⟂ is a NUL separator.

- **Item IDs** are now stable when a receipt is re-synced, which fixes contract mismatch #5.
- **Returns and adjustments** use their SQLite natural key, so the IDs no longer depend on the device.
- **`idKey`** is 32 random bytes, generated by the server at first setup and stored in `instance_settings`. It is handed to each enrolled device and is identical across devices and reinstalls.
- **Without a cloud,** a device that only exports JSON generates its own key.
- **The key is never part of the JSON export.** It is part of the D1 SQL dump, which is the disaster-recovery artifact.

## 4. Authentication

### 4.1 Owner (web)

**Owner access key**
- A ≥ 128-bit random key, generated by `npm run auth:generate-key` and kept in the owner's password manager.
- Its SHA-256 is stored as the secret `OWNER_ACCESS_KEY_SHA256` (`wrangler pages secret put`). The plaintext key is never stored.
- A fast hash is enough because the key is high-entropy, not a human password, so it can't be dictionary-guessed. A slow KDF would also exceed the 10 ms free-plan CPU limit.
- The comparison is constant-time.

**Login**
- `POST /api/auth/login {accessKey}` creates a session.
- The session token is 256-bit random. Only its SHA-256 is stored in `sessions`.
- The cookie is `__Host-ctsession`: `HttpOnly; Secure; SameSite=Strict; Path=/`, with a 30-day sliding expiry.
- `POST /api/auth/logout` deletes the session.
- **Rotating the key** (replacing the secret) invalidates new logins only. "Sign out everywhere" deletes all sessions.

**Optional defence in depth**
- Cloudflare Access (Zero Trust Free, up to 50 users) can sit in front of everything except `/api/device/*` and `/api/sync/*`.
- It isn't required, because the account signup flow may ask for billing details.

### 4.2 Device enrollment (iOS)
1. The signed-in website calls `POST /api/devices/enrollment-codes`.
2. It shows a one-time code (10 base32 characters, about 50 bits, 10-minute TTL, single use; stored as SHA-256). A QR code can be added later.
3. The iOS app sends `POST /api/device/enroll {code, deviceName}`.
4. The response is `{deviceId, deviceToken, idKey}`. The device token is 256-bit random. Only its SHA-256 is stored, and it is shown once.
5. iOS stores the token and `idKey` in the Keychain.

After enrollment:
- The device authenticates with `Authorization: Bearer <deviceToken>`.
- Device tokens can only call `/api/device/*` and `/api/sync/*`. They can't read exports or manage devices.
- `DELETE /api/devices/:id` revokes a device immediately.

### 4.3 Request protection
- **Cookie-authenticated state-changing requests** must carry a same-origin `Origin` header (CSRF defence on top of `SameSite=Strict`).
- **Bearer requests** ignore cookies.
- **All JSON bodies are size-capped** before parsing.

### 4.4 Brute-force throttling
- Failed logins and enrollment attempts are recorded in `auth_failures`, keyed by kind only.
- More than 10 failures in 15 minutes blocks that kind for everyone, returning 429.
- That is acceptable for a single user, and it avoids storing IP addresses.

## 5. Sync protocol

All bodies are JSON. Records use the Export V1 record shapes, validated by the same Zod schemas.

### 5.1 Start a run
`POST /api/sync/runs`

```json
{ "runId": "<uuid v4, client-generated>", "mode": "incremental" | "full",
  "formatVersion": 1, "exportedAt": "…Z", "currency": "USD", "requestId": null }
```

- The call is idempotent: the same `runId` returns the existing run.
- Open runs older than 24 h become `abandoned` lazily.
- The first run fixes the instance currency, and later runs must match it (`400 currency_mismatch`).
- A web session may only start `incremental` runs.

### 5.2 Send batches
`PUT /api/sync/runs/:runId/batches/:seq`, with `seq` = 0, 1, 2, …

```json
{ "receipts": [ { …AnalyticsReceiptV1, "items": [ …AnalyticsItemV1 without purchaseId ] } ],
  "returns": [ …AnalyticsReturnV1 ], "priceAdjustments": [ …AnalyticsPriceAdjustmentV1 ] }
```

- **Receipt bundles.** A receipt always travels with its complete item set, so items can be replaced atomically.
- **Limits.** At most 200 rows per batch (receipts + items + returns + adjustments) and 256 KiB per body. Bigger batches return `413 batch_too_large`. These limits keep each request under the free-plan 10 ms CPU budget and the per-invocation D1 query limit.
- **Idempotency.** `(runId, seq)` is stored with `payload_sha256`. Replaying the same body returns the stored result with `replayed: true`. A different body under the same `seq` returns `409 batch_conflict`.
- **Atomicity.** All writes of one batch, plus its `sync_batches` row, go into one D1 `batch()`, which is a transaction. A batch is either fully applied or not applied at all.
- **Fixed statement count.** Writes use `INSERT … SELECT … FROM json_each(?)` with the rows bound as one JSON parameter. A batch is about 12 statements whatever its size, which stays far below the bound-parameter and per-invocation query limits.
- **Whole transactions only.** All rows of one return/adjustment transaction must be in the same batch. The server rejects a batch whose rows disagree with already-stored rows of the same `transactionId` (`409 transaction_conflict`), so the importer's per-transaction invariants also hold in D1.

### 5.3 Complete
`POST /api/sync/runs/:runId/complete`

```json
{ "batchCount": N,
  "manifest": { "receiptIds": […], "returnIds": […], "priceAdjustmentIds": […] } }
```

`manifest` is used only with `mode: "full"`.

- **Batch check.** The server checks that batches `0…N-1` all exist. If any are missing it returns `409 missing_batches` listing them, and the client resends.
- **Full mode.** The server diffs the manifest against the stored, non-missing IDs (§6.3).

### 5.4 Other endpoints
- **Abort:** `POST /api/sync/runs/:runId/abort`.
- **Status:** `GET /api/sync/runs/:runId`. Returns the run status, which `seq`s were received, and the counters. This is how an interrupted client resumes.
- **History:** `GET /api/sync/runs?limit=` (web session only).

### 5.5 iOS client algorithm (for the future iOS PR)
1. Snapshot the SQLite rows.
2. Map them to V1 records with IDs from §3.
3. Group items under receipts.
4. Chunk into batches of 200 rows or fewer.
5. Start the run, PUT the batches (retrying on network errors with the same `seq` and body), then complete.

Use `incremental` for routine syncs, sending only receipts and returns/adjustments created or changed since the last run's high-water mark. Use `full` for weekly reconciliation or on demand.

### 5.6 JSON import (bootstrap / disaster recovery)
1. The browser validates the file with the existing `importExportText`.
2. `toSyncBatches()` builds batches from it.
3. The browser runs the same protocol using its session cookie, with `source: "web-import"` and `mode: "incremental"`. Imports never tombstone.

## 6. Idempotency and reconciliation

### 6.1 Content hashes
- `canonicalJson` sorts object keys and keeps array order. Each record is hashed with SHA-256 over its canonical JSON.
- A receipt hash covers the receipt plus its items sorted by `id`.
- `transactionTotalCents` and similar fields are part of the hash, so any change in source values is detected.

### 6.2 Batch planning
`planBatch(existing, incoming)` is a pure, tested function. It decides an action for each incoming record:

| Existing row | Incoming | Action |
|---|---|---|
| none | record | **insert** |
| same hash, not missing | record | **unchanged**: no writes |
| same hash, missing | record | **revive**: clear `missing_since_run_id` |
| different hash | record | **update**. For receipts, items are deleted and re-inserted for that receipt only. |

- Only insert, update and revive actions write rows, so a full re-sync of unchanged data costs reads only.
- Every write bumps `change_seq` to the batch's sequence number.
- `sourcePurchaseId` must resolve to a receipt in the batch or in D1. It is never computed.

### 6.3 Full-mode reconciliation (`planMissing`)
- The server reads the IDs of all non-missing rows per table, which costs reads but no writes.
- It diffs them against the manifest. Rows absent from the manifest are **tombstoned** (`missing_since_run_id = run`), never deleted.
- **Mass-removal guard.** If tombstoning would affect more than 20% of a table, or more than 50 rows, the run ends as `needs_review` and nothing is tombstoned. The owner can confirm on the website (`POST /api/sync/runs/:runId/confirm-removals`, a later UI step) or ignore it.
- This protects against a wiped or partially restored iOS database silently erasing history.
- Tombstoned rows reappear (are revived) as soon as any sync sends them again.

### 6.4 Why receipts are replaced as a bundle
iOS deletes and re-inserts a receipt's items on every re-sync, and a `WHSE_` collision replaces the whole trip. The receipt is the unit iOS itself treats as atomic, so the server replaces items per receipt. Nothing else is deleted implicitly.

## 7. Website-triggered refresh and browser cache

**Why the website can't trigger sync directly**
- Costco authentication lives only on the phone, and the website can't reach the phone.
- Push via APNs needs a paid Apple Developer membership, which a SideStore-installed app does not have.
- So refresh is **pull-based**.

**Request flow**
1. The website sends `POST /api/sync-requests`. This creates a `pending` request, or returns the existing pending one, so at most one is pending at a time.
2. iOS checks `GET /api/device/sync-requests`:
   - on launch and on foreground;
   - from `BGAppRefreshTask`, which runs best-effort at times iOS decides;
   - on a manual pull-to-refresh.
3. iOS calls `POST /api/device/sync-requests/:id/ack`, so the website shows "phone is syncing…".
4. iOS runs a sync with `requestId` set. Completing that run marks the request `fulfilled`.
5. Requests expire after 7 days.

The website shows the state honestly: "Requested — open CostcoTracker on your phone if nothing happens".

**IndexedDB cache.** IndexedDB holds the last downloaded dataset plus a `change_seq` high-water mark. The browser refreshes with `GET /api/export/<collection>?sinceSeq=`, which returns only changed and tombstoned rows. Analytics stay pure client-side functions over the cached dataset. That keeps D1 reads and Worker CPU low, and it keeps the existing traceability model intact.

## 8. Expected free-tier usage

Assumed "normal usage": about 150 receipts/year, 4,000 item lines/year, 20 returns/year and 10 adjustments/year. Over 5 years that is about 25k rows. Free limits come from Cloudflare's docs: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

| Resource | Free limit | Daily incremental sync | Weekly full reconciliation | One-time 5-year bootstrap | Website, per visit |
|---|---|---|---|---|---|
| Function requests | 100k/day | ~5 | ~130 (25k rows / 200) | ~130 | ~5–30 (delta fetch) |
| CPU per request | 10 ms | small batches; plain Zod plus hashing of ≤200 rows | same | same | paginated export of 500 rows/page |
| D1 rows read | 5M/day | < 1k | ~75k (hash lookups plus ID diff) | ~50k | delta only; a cold full fetch is ~25k |
| D1 rows written | 100k/day | ~50–200 | ~130 (batch log only when unchanged) | ~25k rows plus index writes, roughly ≤ 75k | ~1 (session touch) |
| D1 storage | 5 GB account; 500 MB per DB | — | — | ~20–40 MB after 5 years | — |

**Notes on the estimates**
- **Usage relative to the limits.** Every daily figure stays below 2% of the free limits. The bootstrap is the only spike.
- **Very large histories.** If a history exceeds about 100k written rows, the server returns `503 daily_limit` when D1 refuses writes. The run stays `open` and resumes after 00:00 UTC, so no data is lost.
- **Unverified limits.** The 500 MB per database, 50 D1 queries per invocation and Time Travel retention could not be confirmed against Cloudflare's docs from this environment. The design keeps a wide margin: a batch uses about 18 D1 statements in total (reads plus one write transaction), whatever the row count.

## 9. Privacy and security model

### What is stored in the cloud
The Export V1 fields only:
- dates, warehouse strings, item numbers and descriptions, quantities, cents, transaction types;
- opaque IDs;
- operational metadata: device names, run counters, hashed tokens.

### Never stored
- Costco cookies, passwords or tokens;
- receipt or transaction barcodes, `WHSE_` keys, online order numbers;
- payment data, return photos, device identifiers, IP addresses.

### How this is enforced
- **Allowlist.** Zod schemas strip unknown keys.
- **Secret-like field names.** The server *rejects* (400 `forbidden_field`) any sync payload containing keys matching `/cookie|password|passwd|token|authorization|session|secret|bearer|barcode/i` at any depth, so a buggy client can't push credentials or barcodes even into ignored fields.
- **Tokens and codes** are stored only as SHA-256.

### Who can read the data
- The owner, with a session.
- Cloudflare, as the processor: D1 is encrypted at rest by Cloudflare, but this is **not** end-to-end encryption.
- End-to-end encryption was rejected because it prevents server-side reconciliation and delta queries. Purchase history is sensitive but not credential-grade, and the owner explicitly opted into cloud storage. This trade-off must be stated in `PRIVACY.md`.

### Other controls
- **No telemetry.** No logging of request bodies. Worker logs contain only route, status and error code.
- **CSP.** `connect-src 'self'`: the page may only call its own `/api/*`. It never allows third parties (no analytics, fonts or CDNs).

## 10. Backup and export
1. **Analytics JSON (owner-facing).** `GET /api/export/meta` plus paginated `GET /api/export/{receipts|items|returns|priceAdjustments}?cursor=&limit=500`. The browser assembles an Export V1 file and **validates it with the existing importer** before offering the download, so the round trip is proven every time. Tombstoned rows are excluded by default.
2. **Full SQL dump (operator).** `wrangler d1 export <db> --remote --output backup.sql`. This includes sessions, devices, history and `idKey`, so it should be kept private.
3. **D1 Time Travel.** Point-in-time restore within D1's free retention window, with no setup.

## 11. Failure recovery

| Failure | Behaviour |
|---|---|
| Network drop mid-run | The client calls `GET /api/sync/runs/:id`, resends missing `seq`s, and completes. Replays are no-ops. |
| Client crash / never completes | The run is `abandoned` after 24 h. Applied batches stay applied, because each one is individually valid. No tombstoning happens without `complete`. |
| D1 daily write cap | `503 daily_limit`. The run stays open and resumes tomorrow. |
| Worker CPU exceeded (1102) | The client halves the batch size and retries the same `seq` with a new body. Allowed because nothing was stored for it. |
| iOS DB wiped or restored | A full sync hits the mass-removal guard and becomes `needs_review`. No tombstones. |
| Device lost | Revoke it on the website. |
| Access key leaked | Rotate the secret and run "sign out everywhere". |
| D1 corrupted or deleted | Time Travel restore, or a fresh D1 with migrations, then JSON import (the IDs are deterministic, so a later iOS sync reconciles) or the SQL dump. |
| Moving off Cloudflare | Run migrations on SQLite/Postgres, import the SQL dump or JSON, then run `server/app.ts` on Node/Bun/Deno with the node:sqlite adapter or a pg adapter. |

## 12. Local development (no Cloudflare account needed)
- `npm run dev` runs the SPA only, unchanged.
- `npm run db:migrate:local` applies the migrations to a local D1 (Miniflare, under `.wrangler/`).
- `npm run dev:cloud` builds, then runs `wrangler pages dev dist`, which serves the SPA plus `/api/*` against the local D1.
- Secrets go in `.dev.vars`, which is gitignored; see `.dev.vars.example`. Generate a key with `npm run auth:generate-key`.
- Tests run the real handler against an in-memory `node:sqlite` database with the real migration file. They need no wrangler and no network.

## 13. Alternatives considered

| Option | $0 indefinitely? | Fit for this project |
|---|---|---|
| **Cloudflare Pages + Workers + D1** (chosen) | Yes. Free plans are documented as permanent. Nothing pauses. | One vendor covers static hosting, API and SQL on one origin. D1 is SQLite, so the schema is portable. Excellent local emulation. Costs: the 10 ms CPU limit forces small batches, Cloudflare holds the data, and bindings are vendor-specific (isolated in one file). |
| **Supabase Free** | Conditional. Free projects **pause after ~1 week of inactivity** and must be resumed manually. | Postgres, built-in auth and RLS are attractive. But a personal app that is sometimes idle for weeks would see iOS background sync fail against a paused project. That fails "operate indefinitely" without a keep-alive hack. |
| **Turso Free** | Yes for the database, with a generous free tier. | libSQL is SQLite, so the schema ports almost unchanged. But Turso is only a database: an API host is still needed (Workers, Vercel and so on), which means two vendors and two sets of credentials. It is a good **migration target** for the DB layer behind the same handler. |
| **Self-hosted Docker / Postgres** | $0 only if always-on hardware already exists. | Best privacy, since no third party holds data. But it needs a publicly reachable HTTPS endpoint for the phone (Cloudflare Tunnel or Tailscale), plus patching, backups and uptime handled by the owner. Supported as the exit path via the portable handler, with only minor SQL dialect differences (`INSERT … ON CONFLICT`, TEXT dates and INTEGER cents all work in Postgres). |

**Verdict.** Cloudflare is the best fit for this project. The dataset is tiny compared with the free limits, and the free tier does not pause. Static, API and database share one origin, so auth stays simple. The only real cost is trusting Cloudflare with purchase history, and the self-host path exists for when that trust or the free terms change.

## 14. Anything that could ever require paid infrastructure

| Feature | Why it might cost money | Status |
|---|---|---|
| Instant push-triggered iOS sync | APNs needs the Apple Developer Program ($99/yr) | Not used. The pull-based flow is the design. |
| Custom domain | Domain registration (~$10/yr) | Optional. `*.pages.dev` is free. |
| Server-side heavy analytics | Could exceed the 10 ms CPU limit | Avoided. Analytics run in the browser. |
| History beyond ~100k written rows per day, or >500 MB | D1 free caps | A bootstrap spreads across days. Size would take decades. |
| Longer point-in-time recovery | Time Travel retention is longer on paid | Use exported backups instead. |
| AI categorization (future) | External LLM APIs are paid; Workers AI has a small free allocation | Optional future feature, off by default. |
| Cloudflare Access | Zero Trust Free covers ≤50 users, but signup may ask for billing details | Optional layer, not required. |
| Email or alerting | Third-party email services | Not planned. |
