-- CostcoTracker Analytics — D1 schema v1 (docs/CLOUD_ARCHITECTURE.md §2).
-- Portable SQLite: money is INTEGER cents, dates are TEXT YYYY-MM-DD,
-- timestamps are ISO-8601 UTC TEXT. Tombstones, never hard deletes, for
-- analytics rows.

CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Single monotonic counter used as `change_seq` for delta fetches.
CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO sequences (name, value) VALUES ('change_seq', 0);

-- ── Auth ────────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  token_sha256 TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE enrollment_codes (
  code_sha256 TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  device_id TEXT REFERENCES devices(id)
);

CREATE TABLE auth_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('login', 'enroll')),
  occurred_at TEXT NOT NULL
);
CREATE INDEX auth_failures_kind_time ON auth_failures (kind, occurred_at);

-- ── Sync bookkeeping ────────────────────────────────────────────────────────
CREATE TABLE sync_requests (
  id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'fulfilled', 'expired')),
  acknowledged_at TEXT,
  acknowledged_by_device_id TEXT REFERENCES devices(id),
  fulfilled_run_id TEXT,
  fulfilled_at TEXT
);
CREATE INDEX sync_requests_status ON sync_requests (status, requested_at);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  device_id TEXT REFERENCES devices(id),
  source TEXT NOT NULL CHECK (source IN ('ios', 'web-import')),
  mode TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'needs_review', 'aborted', 'abandoned')),
  format_version INTEGER NOT NULL,
  exported_at TEXT NOT NULL,
  request_id TEXT REFERENCES sync_requests(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  batch_count INTEGER NOT NULL DEFAULT 0,
  receipts_inserted INTEGER NOT NULL DEFAULT 0,
  receipts_updated INTEGER NOT NULL DEFAULT 0,
  receipts_revived INTEGER NOT NULL DEFAULT 0,
  receipts_unchanged INTEGER NOT NULL DEFAULT 0,
  items_written INTEGER NOT NULL DEFAULT 0,
  returns_inserted INTEGER NOT NULL DEFAULT 0,
  returns_updated INTEGER NOT NULL DEFAULT 0,
  returns_revived INTEGER NOT NULL DEFAULT 0,
  returns_unchanged INTEGER NOT NULL DEFAULT 0,
  adjustments_inserted INTEGER NOT NULL DEFAULT 0,
  adjustments_updated INTEGER NOT NULL DEFAULT 0,
  adjustments_revived INTEGER NOT NULL DEFAULT 0,
  adjustments_unchanged INTEGER NOT NULL DEFAULT 0,
  marked_missing INTEGER NOT NULL DEFAULT 0,
  -- JSON {"receipts":[…],"returns":[…],"priceAdjustments":[…]} while needs_review.
  pending_removals_json TEXT,
  error_code TEXT
);
CREATE INDEX sync_runs_started ON sync_runs (started_at);
CREATE INDEX sync_runs_status ON sync_runs (status, started_at);

CREATE TABLE sync_batches (
  run_id TEXT NOT NULL REFERENCES sync_runs(id),
  seq INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  -- Counts only (no record values).
  result_json TEXT NOT NULL,
  change_seq INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- ── Analytics data (mirrors Export V1) ──────────────────────────────────────
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('warehouse', 'online', 'synthetic')),
  identifier_kind TEXT NOT NULL CHECK (identifier_kind IN ('transactionBarcode', 'synthesizedWarehouseKey', 'onlineOrderKey', 'synthetic')),
  purchase_date TEXT,
  warehouse TEXT,
  bundle_hash TEXT NOT NULL,
  first_seen_run_id TEXT NOT NULL,
  last_changed_run_id TEXT NOT NULL,
  missing_since_run_id TEXT,
  change_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX receipts_change_seq ON receipts (change_seq);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  item_number TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
  unit_price_cents INTEGER CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0)
);
CREATE INDEX items_receipt ON items (receipt_id);
CREATE INDEX items_item_number ON items (item_number);

CREATE TABLE item_returns (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  item_number TEXT NOT NULL,
  return_date TEXT,
  warehouse TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  description TEXT,
  transaction_type TEXT,
  merchandise_amount_cents INTEGER CHECK (merchandise_amount_cents IS NULL OR merchandise_amount_cents >= 0),
  transaction_total_cents INTEGER,
  source_purchase_id TEXT REFERENCES receipts(id),
  content_hash TEXT NOT NULL,
  first_seen_run_id TEXT NOT NULL,
  last_changed_run_id TEXT NOT NULL,
  missing_since_run_id TEXT,
  change_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (transaction_id, item_number)
);
CREATE INDEX item_returns_change_seq ON item_returns (change_seq);

CREATE TABLE price_adjustments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  item_number TEXT NOT NULL,
  adjustment_date TEXT,
  warehouse TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  adjusted_quantity REAL CHECK (adjusted_quantity IS NULL OR adjusted_quantity > 0),
  reference_line_numbers TEXT NOT NULL, -- JSON array of strings
  transaction_type TEXT,
  transaction_total_cents INTEGER NOT NULL,
  source_purchase_id TEXT REFERENCES receipts(id),
  content_hash TEXT NOT NULL,
  first_seen_run_id TEXT NOT NULL,
  last_changed_run_id TEXT NOT NULL,
  missing_since_run_id TEXT,
  change_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (transaction_id, item_number)
);
CREATE INDEX price_adjustments_change_seq ON price_adjustments (change_seq);
