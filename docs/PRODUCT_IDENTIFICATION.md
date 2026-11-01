# Product identification by Costco item number

When a Costco item number is available, the system identifies the product with a **targeted web search**, not with AI. AI is used afterwards, only to normalize what the search found and to suggest categories that the deterministic rules still can't place.

| Question | Tool |
|---|---|
| "What actual product is Costco item #1627770?" | Targeted web search, cached by item number |
| "Given that product, what is its clean name / brand / type?" | Workers AI normalization (optional; falls back to the cleaned search title) |
| "Which category is it?" | Deterministic rules on the receipt description, then on the identified name; AI suggestion with owner review only if the rules still can't decide |

## Pipeline

```
Dashboard → Categories → "Suggest categories with AI" (owner click; Uncategorized items only)
  │
  ├─ 1. POST /api/products/identify (≤ 10 items per request: item number + receipt description)
  │      a. D1 cache lookup (product_identities)          → hit: returned immediately, no search
  │      b. miss → web search "Costco <item#> <description>", then "Costco \"<item#>\""
  │         A result counts only if its title, URL or snippet contains the EXACT item number.
  │      c. optional Workers AI normalization (one call per batch) → name, brand, product type
  │      d. cache the outcome (identified; or not_found, retried after 30 days)
  │
  ├─ 2. Deterministic rules (in the browser, analytics engine)
  │      receipt descriptions first; if none match, the identified name / product type
  │      → an item a rule now matches is categorized, with no AI and no override
  │
  └─ 3. POST /api/categories/suggest for what is still Uncategorized
         (the model also sees the cached identity as "identifiedAs")
         → owner review: Accept / Change / Leave uncategorized (unchanged)
```

- On every dashboard load, cached identities are fetched once with the dataset (`GET /api/products/identities`), so rules use them immediately, with no search.
- In practice a Costco item number is researched once.

## Design decisions

1. **Where identity data lives.** The schema had no product table.
   - `items` stores receipt **lines**: many rows per SKU, keyed by line ID and rewritten by iOS sync.
   - Putting identity columns on `items` would duplicate the data on every line and get overwritten by sync.
   - So there is a new **`product_identities`** table, keyed by `item_number` (migration `0002_product_identities.sql`). It holds only public product information: name, brand, type, source URL, optional image URL, confidence, method, provider and lookup time.
   - It is **not** part of Export V1, the sync protocol or the backup. It is a re-derivable cache and can be deleted at any time.
2. **Where it plugs into the request flow.**
   - A new owner-only endpoint, `POST /api/products/identify`, does cache lookup → search → normalize → cache.
   - `GET /api/products/identities` is loaded together with the dataset by `CloudDatasetProvider`. It is kept in memory, so switching tabs still re-downloads nothing.
   - Rules run in the analytics engine (`categorize(…, identityTexts)`). Identified names are consulted **only after** the receipt descriptions, so no existing rule result changes. The assignment records `basis: 'receipt' | 'identity'`, and the item drawer shows it together with the source link.
   - AI fallback is the existing suggestion endpoint, which now adds the cached identity to its prompt.
3. **Adapting the category-suggestion system rather than replacing it.**
   - Same button, same session.
   - The session runs an "identify" phase first, then sends to the AI only the items the rules still can't place.
   - Owner review, overrides, limits and privacy rules are all unchanged.
   - If the lookup fails or search isn't configured, the AI step still runs as before.
4. **Local-file mode.** There is no identification there: no server, no search. It is unaffected.

## Privacy boundary

**Sent to the web search provider:** the literal word "Costco", the Costco item number and the abbreviated receipt description. Nothing else.
- The request schema is strict: extra fields are rejected with 400.
- Queries are built only from those two values; quotes and `*` are stripped.
- Tests assert the exact queries.

**Sent to Workers AI for normalization:** item number, receipt description, and the matched search result's title and snippet. All of this is public text.

**Never sent:**
- receipt barcode, order numbers, receipt or line IDs;
- purchase dates, warehouse, prices, spend, quantities;
- returns and adjustments;
- purchase history;
- account, session or device data and Costco credentials.

**No scraping.** Only the search API is called. Costco's site (or any result page) is never fetched; the system uses only the title, URL, snippet and thumbnail URL that the search API returns.

**Third party.** This is the one feature that sends data outside Cloudflare: item number and description go to the search provider. It runs only after an owner click. See `PRIVACY.md`.

## Search provider and setup

**Provider:** the Brave Search API, through a small `WebSearch` adapter in `server/products/search.ts` (`GET https://api.search.brave.com/res/v1/web/search`, header `X-Subscription-Token`). Swapping providers means writing one adapter and choosing it in `server/products/config.ts`.

**Setup (Cloudflare Pages):**
1. Apply the migration to D1:
   ```bash
   npm run db:migrate:remote
   ```
2. Add the secret `SEARCH_API_KEY`, either with `wrangler pages secret put SEARCH_API_KEY` or in **Pages project → Settings → Variables and Secrets** as an encrypted variable. Then redeploy.
3. Optional: add the Workers AI binding `AI` (see `docs/AI_CATEGORY_SUGGESTIONS.md`) for normalization and category suggestions.

**Without `SEARCH_API_KEY`:**
- Identification serves cached identities only.
- Unknown items are reported as `unavailable`, and the dashboard notes that web search is not set up.
- The AI step runs as before.

**Without the migration:** loading identities fails quietly (none are used); identification requests fail and the AI step runs as before.

## Cost and request controls
- Cache first: an item number is searched once. Results with nothing found are retried after 30 days. A failed search is not cached.
- At most 2 queries per item; the second only if the first finds nothing.
- At most 10 items per request and 100 items per click.
- Best-effort limit of 10 requests per 10 minutes per Workers isolate.
- At most one AI normalization call per request.
- Nothing runs in the background.
- Check your search provider's current free tier and pricing. A few hundred unknown items use a few hundred to about a thousand queries **once**.

## Reliability rules (same physical product)
- A search result is accepted only if it contains the **exact** item number as a whole number. "16277701" does not match "1627770", and a product that is merely similar but lacks the number is rejected.
- costco.com results are preferred (confidence 0.9). Otherwise a result corroborated by a second one gets 0.8, and a single other site 0.7.
- Rules and the AI use an identity only at confidence ≥ 0.6.
- The AI normalizer may only rename and describe the found result. If its output is invalid, the cleaned search title is used.

## Next: photo-based return matching (design, not built yet)

The identity cache is the foundation for this. The plan:
1. `POST /api/products/match-photo`, owner-only. A Workers AI vision model extracts visible text clues from the photo (brand, product name, package text, UPC if readable). The photo itself is not stored.
2. Candidates come from the owner's own purchase history, which is already in D1 (`items`): item numbers whose cached identity (name, brand, type) or receipt description overlaps the clues, scored deterministically (token overlap, brand match, UPC match when available).
3. Top candidates without a cached identity are identified first with the same `identifyItems` pipeline: cache, then targeted search by item number.
4. Only if more than one candidate remains, an AI comparison step ranks them against the photo clues. It returns the best item number and a confidence, or abstains.
5. The dashboard then shows every purchase of that exact item number (existing item drill-down) so the owner can pick the receipt.

**Privacy for photo matching:**
- The vision model sees the photo, inside the owner's Cloudflare account.
- Web search sees only item numbers, descriptions and generic product text from the photo.
- Purchase history never leaves D1.
