-- Our own local Costco product catalog: one row per item number, holding
-- OUR resolved product record for that SKU. It is not a copy of any search
-- provider's results:
-- - web search (Brave, including a site: query for Warehouse Runner product
--   pages) is used only transiently, inside one identify request, to discover
--   the product;
-- - no search-result titles, snippets, URLs, thumbnails, rankings or
--   responses are stored here (there are no columns for them);
-- - a resolved SKU is never searched again.
-- Public product information only; never purchase data. Not part of Export V1
-- or the sync protocol, so iOS sync never touches it.
CREATE TABLE product_identities (
  item_number TEXT PRIMARY KEY,
  -- 'resolved': we established the product (strong evidence) — permanent, never re-searched.
  -- 'unresolved': the last lookup found only weak evidence or nothing; retried after retry_after.
  status TEXT NOT NULL CHECK (status IN ('resolved', 'unresolved')),
  -- From our own receipt data (the text we looked up), not from search results.
  receipt_description TEXT NOT NULL,
  -- Our canonical product record (resolved rows only).
  canonical_name TEXT,
  brand TEXT,
  product_type TEXT,
  -- Our confidence in the resolution, from the evidence class (never raised by AI).
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  -- Why we accepted it: Costco's own page named the item number, a Costco-specialist product page
  -- for exactly that item number did, or 2+ independent agreeing sources did.
  -- 'owner-confirmed' is reserved for the planned owner confirmation of a provisional match, so that
  -- feature needs no table rebuild (SQLite cannot alter a CHECK); nothing writes it yet.
  resolution_basis TEXT CHECK (resolution_basis IS NULL OR resolution_basis IN ('costco.com', 'costco-specialist', 'corroborated', 'owner-confirmed')),
  -- Unresolved rows: what the last lookup found ('provisional' = one ordinary source only).
  last_outcome TEXT CHECK (last_outcome IS NULL OR last_outcome IN ('provisional', 'not_found')),
  -- How the mapping was established: 'web-search' or 'web-search+ai' (AI-normalized name).
  method TEXT NOT NULL,
  resolved_at TEXT,
  last_attempt_at TEXT NOT NULL,
  retry_after TEXT,
  CHECK (
    (status = 'resolved' AND canonical_name IS NOT NULL AND resolution_basis IS NOT NULL
      AND resolved_at IS NOT NULL AND last_outcome IS NULL AND retry_after IS NULL)
    OR
    -- An unresolved row can hold no product details at all: weak evidence is never saved as an identity.
    (status = 'unresolved' AND canonical_name IS NULL AND brand IS NULL AND product_type IS NULL
      AND resolution_basis IS NULL AND confidence = 0 AND last_outcome IS NOT NULL AND retry_after IS NOT NULL)
  )
);
