# Product identification by Costco item number

When a Costco item number is available, the product is identified with a **targeted web search**, not with AI. The search is a **transient discovery step**. What we keep is **our own local product catalog**: one resolved record per Costco item number, stored in D1. A resolved item number is never searched again.

```
unknown SKU ─► Brave lookup (transient) ─► resolve identity in that request ─► our own local catalog record
then, permanently:   SKU ─► our own local catalog record   (no further searches)
```

| Question | Tool |
|---|---|
| "What actual product is Costco item #1627770?" | Targeted web search, once per item number, used transiently |
| "What is its clean name / brand / type?" | Resolved during that request: the cleaned result title, optionally normalized by Workers AI |
| "Which category is it?" | Deterministic rules on the receipt description, then on our canonical product name; AI suggestion with owner review only if the rules still can't decide |

## Pipeline

```
Dashboard → Categories → "Suggest categories with AI" (owner click; Uncategorized items only)
  │
  ├─ 1. POST /api/products/identify (≤ 10 items per request: item number + receipt description)
  │      a. local catalog lookup (product_identities)
  │           resolved → our own record; no search, ever again
  │           unresolved and before retry_after → no search
  │      b. otherwise search, stopping at the first strong evidence (≤ 3 Brave queries):
  │           1. "Costco <item#> <description>"
  │           2. "site:app.warehouserunner.com <item#>"   (item number only)
  │           3. "Costco \"<item#>\""
  │         A result counts only if its title, URL or snippet contains the EXACT item number.
  │      c. strong evidence → resolve: canonical name (optionally AI-normalized), brand, type
  │         weak/no evidence → stays unresolved (outcome + retry time only)
  │      d. save OUR outcome; discard every search result (titles, snippets, URLs, thumbnails, ranking)
  │
  ├─ 2. Deterministic rules (in the browser, analytics engine)
  │      receipt descriptions first; if none match, the canonical name / product type
  │      → an item a rule now matches is categorized (no AI, no override)
  │
  └─ 3. POST /api/categories/suggest for what is still Uncategorized
         (the model also sees our resolved record as "identifiedAs")
         → owner review: Accept / Change / Leave uncategorized (unchanged)
```

On every dashboard load, the resolved catalog is fetched once with the dataset (`GET /api/products/identities`), so the rules use it immediately, with no search.

## What is persisted versus transient

**Persisted in D1 (`product_identities`).** This is our own resolved record, one row per item number:

| Column | Meaning |
|---|---|
| `item_number` | Costco item number (key) |
| `status` | `resolved` (permanent, never re-searched) or `unresolved` (retried after `retry_after`) |
| `receipt_description` | The receipt text we looked up. This is our own data |
| `canonical_name`, `brand`, `product_type` | Our canonical product record (resolved rows only) |
| `confidence` | Our confidence, from the evidence class only (0.9 Costco.com, 0.85 Costco-specialist, 0.8 corroborated); 1 for owner-confirmed (the owner's assertion, not search certainty) |
| `resolution_basis` | Why we accepted it: `costco.com`, `costco-specialist`, `corroborated` (our classification, not search content) or `owner-confirmed` (the owner said so) |
| `last_outcome` | Unresolved rows: `provisional` (one ordinary source) or `not_found` |
| `method` | `web-search`, `web-search+ai` (AI-normalized name) or `owner` (owner-confirmed) |
| `resolved_at`, `last_attempt_at`, `retry_after` | Timestamps |

- `owner-confirmed` was already allowed by migration 0002's CHECK, so owner confirmation needed no new migration. (The migration's comment still calls it "reserved"; applied migrations are not edited.)
- **Unresolved rows can't hold product details.** A database CHECK constraint enforces this: `canonical_name`, `brand`, `product_type` and `resolution_basis` must be NULL and `confidence` must be 0. Weak evidence therefore can never become a stored identity.
- **No column can hold search-result content.** A test checks the column names.

**Transient (memory of one request only, never written to D1):**
- every search result's title, snippet and URL;
- thumbnail or image URL;
- the result ranking;
- the raw Brave response;
- the candidate name of a provisional match (returned once to the dashboard and shown in that review session);
- the text sent to Workers AI for normalization.

Tests plant marker strings in snippets, URLs, thumbnails, non-chosen results and provisional titles. They then scan **every table** in D1 to confirm none of them were stored. The dashboard keeps no third-party links either.

## Design decisions
1. **A table keyed by item number, not columns on `items`.** `items` stores receipt **lines**: many per SKU, keyed by line ID, and rewritten by iOS sync. `product_identities` (migration `0002`) is our catalog of public product information. It is outside Export V1, the sync protocol and backups.
2. **Where it plugs in:**
   - `POST /api/products/identify` (owner-only, strict schema, ≤ 10 items, rate-limited) does the catalog lookup, then transient search, then resolve, then save our outcome.
   - `GET /api/products/identities` returns resolved records only. `CloudDatasetProvider` loads them with the dataset and keeps them in memory, so tab switches still trigger no downloads.
   - The analytics engine applies them in `categorize(…, identityTexts)`: the canonical name and type are tried **only after** the receipt descriptions, so no existing rule result changes. Assignments record `basis: 'receipt' | 'identity'`, and the item drawer shows the catalog record and how it was resolved.
   - The existing AI suggestion endpoint adds resolved records to its prompt.
3. **Suggestion flow adapted, not replaced.** Same button and session, with an "identify" phase first. Owner review, overrides, limits and privacy are unchanged. If identification fails or search isn't configured, the AI step runs as before.
4. **Local-file mode** has no identification (no server, no search) and is unaffected.

## Reliability rules (same physical product)
- A search result counts only if it contains the **exact** item number as a whole number. "16277701" does not match "1627770", and a similar product without the number is rejected.
- **Evidence during the live lookup decides the outcome:**

  | Evidence (in the request) | Outcome saved | Confidence | Used by rules and the AI prompt? |
  |---|---|---|---|
  | Costco's own page names the exact item number | `resolved`, basis `costco.com` | 0.9 | Yes |
  | A Costco-specialist **product page** for exactly that item number, as returned by Brave (see below) | `resolved`, basis `costco-specialist` | 0.85 | Yes |
  | 2+ independent sites (different hosts) name it **and** their titles agree (≥ 2 significant shared words) | `resolved`, basis `corroborated` | 0.8 | Yes |
  | Only one ordinary site, or sites that disagree | `unresolved`, outcome `provisional` (no details stored) | — | **No.** The candidate name is shown this session as a "possible match (not saved or used)"; the item goes to the AI step; it is looked up again after 30 days |
  | No result names the item number | `unresolved`, outcome `not_found` | — | No; retried after 30 days |

- Several pages of the same site count as one source, including its subdomains (`app.warehouserunner.com` and `warehouserunner.com` are one site).
- `isUsableIdentity` is the single gate for using a record: `resolved`, basis `costco.com`, `costco-specialist` or `corroborated`, confidence ≥ 0.6.

### Costco-specialist evidence (Warehouse Runner)
Warehouse Runner keeps a Costco-specific product database keyed by Costco item number, and Brave indexes its product pages. A Brave result counts as `costco-specialist` evidence only when **all** of these hold (`isSpecialistProductPage` in `server/products/search.ts`):
- the URL is `https` and its hostname is **exactly** `app.warehouserunner.com` or `warehouserunner.com`;
- the path is `/costco/<itemNumber>`, optionally followed by `-<slug>` and/or `/`, for **this** item number (whole-number match, as everywhere else);
- it is therefore a product page. Category, store, search and deal-list pages, and another item's page that merely mentions our number, are ordinary single-source evidence.

**What we do and don't do:**
- Warehouse Runner is never fetched, scraped or called. We use only the title Brave already returned, transiently, exactly as for any other result. There is no extra API key or cost.
- **Targeted Brave query.** If the normal query isn't strong, a Brave `site:app.warehouserunner.com <itemNumber>` query (item number only) can surface product pages Brave ranks low. It is still just a Brave search. Its results go through exactly the same checks (exact item number, exact host, `/costco/<itemNumber>` product path); nothing is trusted because it came from a `site:` query. Results from all queries are judged together, so two agreeing sites found by different queries can also corroborate.
- Its prices, availability and related items are never read or stored. As with every search result, we keep only our own canonical record (name, brand, type, basis, confidence).
- Their Terms of Use require their official Business API (`access@warehouserunner.com`) or written permission for automated catalog synchronization, bulk extraction or building product datasets. This feature does none of those: it makes owner-triggered Brave queries and never contacts Warehouse Runner.
- **AI never manufactures certainty.** Confidence comes only from the evidence class. AI normalization runs only on strong candidates, and only renames or describes them; it never changes the outcome or confidence.
- An unresolved item can later become resolved if stronger evidence appears at a retry. A resolved record is never overwritten by a lookup, because it is never looked up again.

## Privacy boundary
**Sent to Brave:** the word "Costco", the Costco item number and the abbreviated receipt description, and nothing else. The `site:app.warehouserunner.com` query carries the item number only.
- The request schema is strict (extra fields → 400).
- Queries are built only from those two values; quotes and `*` are stripped.
- Tests assert the exact queries.

**Sent to Workers AI for normalization:** item number, receipt description, and the matched result's title and snippet. This is transient; it is not stored.

**Naming rules for normalization** (`NORMALIZATION_SYSTEM_PROMPT` in `server/products/identify.ts`):
- keep full brand names, especially "Kirkland Signature";
- keep meaningful descriptors and product or model names (Organic, Extra Crispy, Hand Soap, …);
- never abbreviate (Chocolate, not "Choc"; Tortellini, not "Tort");
- remove promotional and price text;
- package size or count may be dropped when it doesn't distinguish the product;
- prefer a clean, human-readable catalog name over a short label.

**Never sent:**
- receipt barcode, order numbers, receipt or line IDs;
- purchase dates, warehouse, prices, spend, quantities;
- returns and adjustments;
- purchase history;
- account, session or device data and Costco credentials.

See `CLAUDE.md` for the bounded exception.

**No scraping.** Only the search API is called. Costco's site, or any result page, is never fetched.

**Provider terms.** Brave's standard Search API terms allow only transient use of results. That is why results are discarded after each request, and only our own resolved record is kept.

## Search provider and setup
**Provider:** the Brave Search API, through the `WebSearch` adapter in `server/products/search.ts` (`GET https://api.search.brave.com/res/v1/web/search`, header `X-Subscription-Token`). Swapping providers means writing one adapter and choosing it in `server/products/config.ts`.

**Setup (Cloudflare Pages):**
1. Apply the migration to D1:
   ```bash
   npm run db:migrate:remote
   ```
2. Add the secret `SEARCH_API_KEY` (your Brave Search API key), either with `wrangler pages secret put SEARCH_API_KEY` or in **Pages project → Settings → Variables and Secrets**. Then redeploy.
3. Optional: add the Workers AI binding `AI` (see `docs/AI_CATEGORY_SUGGESTIONS.md`) for name normalization and category suggestions.

**Fallbacks:**
- Without `SEARCH_API_KEY`, only the local catalog is used. Unknown items are reported as `unavailable`, and the dashboard notes that web search is not set up.
- Without the migration, the catalog reads as empty, so the dashboard and AI suggestions work as before. `POST /api/products/identify` answers **503 `catalog_not_configured`** and searches nothing, because lookups could not be cached. The dashboard shows that as a product-lookup note and still runs the AI step.
- **Brave rate limit:** a 429 response is retried once after 1.1 s. A second 429 marks that item "search failed" (nothing recorded), and it can be looked up again on a later click.

## Live validation (local, read-only)
`npm run validate:search` (`scripts/live/productSearch.live.ts`) runs the production query builder, Brave adapter, evidence classifier and title cleaner against real SKUs. It writes nothing: no D1, no migration, no saved results.
- SKUs come from a backup file (`LIVE_SKUS_FROM_EXPORT=<file>`), taking distinct item numbers in file order. `LIVE_OFFSET` (default 0) skips earlier batches and `LIVE_N` (default 15) sets the batch size. `LIVE_ITEMS=<itemNumber,…>` instead rechecks just those item numbers. The `resolvedBy` column shows which query (normal, `site:warehouserunner` or quoted item #) produced strong evidence. A manual `.live-skus.json` (gitignored) also works.
- Only the item number and receipt description are sent to Brave.
- **Optional `LIVE_AI_NORMALIZE=1`:**
  - runs the production normalization step (`normalizeStrongCandidates` → `toResolvedIdentity`) on resolved matches only;
  - prints `searchName` (cleaned Brave title) next to `canonicalName` (what would be saved);
  - never normalizes provisional or not-found items, and labels them "not resolved".
- **Why it needs a token:** the Pages `AI` binding doesn't exist outside Cloudflare, so `scripts/live/workersAiRest.ts` sends the identical model input to the Workers AI REST API instead. That needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Workers AI permission) in your shell.

## Cost and request controls
- **Local catalog first:** a resolved item number costs zero queries forever. Unresolved items are retried after 30 days. A failed search records nothing.
- **Small requests:**
  - at most 3 queries per lookup (`MAX_QUERIES_PER_ITEM`), each later one only while the evidence is still not strong; a provisional single-source result does not stop the lookup;
  - at most 10 items per request and 100 per click;
  - a best-effort limit of 10 requests per 10 minutes per Workers isolate.
- **Minimal AI:** at most one AI normalization call per request.
- **Nothing runs in the background.**
- **Brave pricing:** $5 per 1,000 requests, with $5 of monthly free credit. Items resolved by the first query cost 1 query; items that stay unresolved cost 3. A few hundred unknown items therefore use a few hundred to roughly 1,000+ queries, once, so a large first review can exceed the monthly free credit; spread it over several clicks or months if needed (each click is at most 100 items).

## Owner-confirmed identities
For an item number search could not resolve (provisional or not found), the owner can state what the product is.

**Where:** Categories → AI category suggestions. A review row without a catalog record has **Confirm identity**. It opens a small form: product name (required), brand and product type (optional). For a provisional match the name is prefilled with the possible match, but nothing is saved until the owner clicks **Save to my catalog**.

**What is saved** (`server/products/ownerIdentity.ts`):
- the owner's name, brand and type, plus our receipt description;
- `status = 'resolved'`, `resolution_basis = 'owner-confirmed'`, `method = 'owner'`, `confidence = 1`.

Confidence 1 means "the owner asserted it", not search certainty. The basis says so, and the dashboard shows **Owner confirmed** instead of a percentage.

**Effect:**
- the item number is never searched again;
- the record is served by `GET /api/products/identities` and used by the rules and the AI prompt like any resolved identity;
- the dashboard applies it immediately, with no reload. The panel reports whether the rules now categorize the item.

**Edit / remove:** the item drawer shows **Edit identity** and **Remove identity** for owner-confirmed records only.
- Remove deletes the catalog row, so a later click may look the item up again.
- Receipts, purchases and category overrides are not touched.
- Records resolved automatically (Costco.com, Costco-specialist, corroborated) cannot be replaced, edited or removed. The API answers 409.

**API** (owner-only, same-origin, strict schemas, a best-effort limit of 60 changes per 10 minutes per isolate):

| Request | Body | Result |
|---|---|---|
| `POST /api/products/confirm` | `{ itemNumber, receiptDescription, canonicalName, brand \| null, productType \| null }` | `{ identity }`. 409 `already_resolved` / `already_confirmed` |
| `PATCH /api/products/identity/:itemNumber` | `{ canonicalName, brand \| null, productType \| null }` | `{ identity }`. 404, or 409 `not_owner_confirmed` |
| `DELETE /api/products/identity/:itemNumber` | — | `{ removed }`. 404, or 409 `not_owner_confirmed` |

**Validation:**
- Any other field is rejected with 400: URLs, snippets, images, prices, dates, warehouse, receipt/order IDs, provider data, confidence or basis.
- Text must be single-line, trimmed and bounded (name ≤ 120, brand and type ≤ 60), and must not be a web address.

## Next: photo-based return matching (design, not built yet)

Our local catalog becomes the source of truth for product identity over time:

```
photo → visible clues → compare to our own SKU catalog → compare to purchase history → Brave only for previously unknown SKU candidates
```

1. **Read the photo.** `POST /api/products/match-photo`, owner-only. A Workers AI vision model extracts visible text clues: brand, product name, package text, UPC if readable. The photo is not stored.
2. **Find candidates.** They come from the owner's own purchase history, already in D1 (`items`): item numbers whose **catalog record** (canonical name, brand, type) or receipt description overlaps the clues. Scoring is deterministic: token overlap, brand match, and UPC match when available.
3. **Fill gaps.** Candidates without a catalog record are resolved with the same `identifyItems` pipeline, a transient Brave lookup, and saved to our catalog.
4. **Rank only if needed.** If more than one candidate remains, an AI comparison ranks them against the photo clues. It returns the best item number with a confidence, or abstains.
5. **Pick the receipt.** The dashboard shows every purchase of that exact item number (the existing item drill-down), so the owner can choose the receipt.

**Privacy for photo matching:**
- The vision model sees the photo, inside the owner's Cloudflare account.
- Brave sees only item numbers, descriptions and generic product text from the photo.
- Purchase history never leaves D1.
