-- Product identity cache: one row per Costco item number, filled by a
-- targeted public web search (POST /api/products/identify). It holds only
-- public product information, never purchase data, and is not part of
-- Export V1 or the sync protocol, so iOS sync never touches it. It can be
-- deleted at any time; items are simply looked up again on request.
CREATE TABLE product_identities (
  item_number TEXT PRIMARY KEY,
  -- 'identified': Costco's own page, or 2+ independent agreeing sites, name this exact item number.
  -- 'provisional': only one non-Costco site does; shown, but never used for categorization.
  -- 'not_found': no result names it. Provisional and not_found are retried after retry_after.
  status TEXT NOT NULL CHECK (status IN ('identified', 'provisional', 'not_found')),
  -- The (abbreviated) receipt description that was searched.
  receipt_description TEXT NOT NULL,
  normalized_name TEXT,
  brand TEXT,
  product_type TEXT,
  source_url TEXT,
  image_url TEXT,
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  -- Why the identity was accepted (traceability): 'costco.com', 'corroborated' or 'single-source'.
  evidence TEXT CHECK (evidence IS NULL OR evidence IN ('costco.com', 'corroborated', 'single-source')),
  -- Distinct sites whose result named the exact item number, and the agreeing second source if any.
  evidence_sources INTEGER NOT NULL DEFAULT 0,
  corroborating_url TEXT,
  -- How the identity was derived: 'web-search' or 'web-search+ai'.
  method TEXT NOT NULL,
  search_provider TEXT,
  looked_up_at TEXT NOT NULL,
  retry_after TEXT,
  CHECK (status = 'not_found' OR normalized_name IS NOT NULL)
);
