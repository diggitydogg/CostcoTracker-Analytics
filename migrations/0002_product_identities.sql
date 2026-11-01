-- Product identity cache: one row per Costco item number, filled by a
-- targeted public web search (POST /api/products/identify). It holds only
-- public product information, never purchase data, and is not part of
-- Export V1 or the sync protocol, so iOS sync never touches it. It can be
-- deleted at any time; items are simply looked up again on request.
CREATE TABLE product_identities (
  item_number TEXT PRIMARY KEY,
  -- 'identified': a search result explicitly mentioned this item number.
  -- 'not_found': nothing did; not searched again before retry_after.
  status TEXT NOT NULL CHECK (status IN ('identified', 'not_found')),
  -- The (abbreviated) receipt description that was searched.
  receipt_description TEXT NOT NULL,
  normalized_name TEXT,
  brand TEXT,
  product_type TEXT,
  source_url TEXT,
  image_url TEXT,
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  -- How the identity was derived: 'web-search' or 'web-search+ai'.
  method TEXT NOT NULL,
  search_provider TEXT,
  looked_up_at TEXT NOT NULL,
  retry_after TEXT,
  CHECK (status = 'not_found' OR normalized_name IS NOT NULL)
);
