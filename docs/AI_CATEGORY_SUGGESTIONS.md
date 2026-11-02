# AI category suggestions (optional)

The deterministic description rules (`src/analytics/categories/rules.ts`) remain the primary, automatic categorizer. AI only **proposes** categories for items that are still **Uncategorized**, and only when the owner asks. The workflow is:

```
description rules ─► Uncategorized ─► [owner clicks] identify by item number (local catalog → transient web search)
                  ─► rules on the identified name ─► still Uncategorized ─► Workers AI suggestion ─► owner review ─► existing category override
```

The identify step is described in `docs/PRODUCT_IDENTIFICATION.md`. When an item has a resolved record in the local product catalog, the AI prompt also receives it as `identifiedAs` (our canonical name, brand and type for that exact item number).

- **No silent changes.** AI suggestions never change analytics. A category changes only when the owner clicks **Accept**, **Accept all high-confidence** or **Change**. That writes the same browser-side category override a manual choice in the item drawer writes. Once accepted, the item has an override, so it is no longer Uncategorized and is never sent to the AI again.
- **Leave uncategorized** and skipped items write nothing.
- **Optional.** The dashboard, local-file mode and all analytics work without it.

## Where it is available

**Cloud mode only.** The feature needs the owner-only cloud API (session cookie and same-origin checks) and the Workers AI binding.

**Local-file mode** has no AI panel. It never needs an API key, never calls the network and stays fully usable. The Uncategorized panel notes that AI suggestions are available in the cloud dashboard.

## Provider and model

| | |
|---|---|
| Provider | Cloudflare Workers AI, through the Pages Functions binding **`AI`**. No OpenAI, Anthropic or other third-party credentials. |
| Model | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Meta Llama 3.3 70B Instruct, FP8, fast) |
| Where to change it | **`server/ai/config.ts`** → `CATEGORY_SUGGESTION_MODEL` (plus temperature, `max_tokens` and the request limit). Nothing else depends on the model id. |

**Why this model:**
- Cloudflare's Workers AI **JSON Mode** documentation lists it as supporting `response_format: { "type": "json_schema", "json_schema": <schema> }`. This feature relies on that for structured output.
- The request passes the schema **bare** under `json_schema`, without OpenAI's `{ name, schema }` wrapper, which is the format Cloudflare documents for native `@cf/` models. A test locks in this request shape.
- It is a generally available instruction-tuned model, not a beta or preview.
- It is large enough to recognize retail brands and Costco-style abbreviations far better than the 8B models.
- It replaces `@cf/meta/llama-3.1-70b-instruct`, which the current JSON Mode documentation does not list.

**Choosing a different model:** use another Workers AI text-generation model that Cloudflare's JSON Mode page lists as supported, and check that page when you change it, because the list changes over time. Even with JSON Mode, the server still validates every answer.

**JSON Mode failures:** Cloudflare documents that JSON Mode can fail with "JSON Mode couldn't be met". That, and any other model error, is reported to the dashboard as a retryable `ai_failed` error for that batch. Nothing is changed.

## Exact privacy boundary

**Sent to the model**, built only by `buildSuggestionItems` in `src/analytics/categories/suggestProtocol.ts`:
- the **item number** (Costco item numbers; format `[A-Za-z0-9][A-Za-z0-9._-]{0,39}`);
- up to **3 description variants** for that item, newest first. Each is cleaned to single-line text and truncated to 120 characters;
- a fixed system prompt containing the category taxonomy and instructions.

**Never sent:**
- purchase dates;
- prices, line totals, spend and quantities;
- warehouses or locations;
- receipt, order or line IDs;
- transaction barcodes or order numbers;
- returns and price-adjustment amounts, or any other receipt content;
- the owner access key, session cookie, device IDs or tokens, `idKey`, and Costco credentials or session data.

**How this is enforced:**
- The builder copies only those two fields, whatever else the input object carries.
- The server request schema is **strict**: any extra field is rejected with HTTP 400 before the model is called.
- `buildModelInput` contains only `messages`, `response_format`, `temperature` and `max_tokens`. There are no tools and no web search.
- Tests assert all of this with records full of prohibited data.

**Nothing is stored server-side.** Suggestions are not persisted in D1, and the D1 schema is unchanged. Errors are logged by class name only, never with the payload.

## Endpoint

`POST /api/categories/suggest`. It is owner-only (session cookie), and same-origin is required, as for every owner write. Devices get 403; unauthenticated callers get 401.

**Request:**
```json
{ "items": [{ "itemNumber": "1712345", "descriptions": ["ANKERSOLIX"] }] }
```

**Request limits** (`SUGGEST_LIMITS`):
- 1–25 unique items;
- 1–3 descriptions each, each 1–120 characters, single-line and trimmed;
- body at most 24 KiB.

**Response:**
```json
{
  "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "suggestions": [{ "itemNumber": "1712345", "categoryId": "electronics", "subcategoryId": null, "confidence": 0.92, "reason": "Anker Solix power station" }],
  "usage": { "promptTokens": 900, "completionTokens": 120, "totalTokens": 1020 }
}
```
- **`categoryId: null`** means the model abstained: leave the item Uncategorized.
- **`usage`** is included only when Workers AI reports token counts. It is diagnostics only: the dashboard shows a total and nothing depends on it.

**Errors:**

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` / `invalid_json` | Malformed or oversized batch |
| 413 | — | Body too large |
| 429 | `rate_limited` | Too many requests |
| 502 | `ai_failed` | The model failed. Retryable, nothing changed |
| 503 | `ai_not_configured` | No `AI` binding |

### Taxonomy-constrained output
- **Allowed categories:** the model may only answer with the app's categories, excluding `uncategorized` (expressed as `null`) and the catch-all `other` (so uncertainty cannot become a category). Grocery subcategories are only valid under Grocery.
- **Prompt:** it gives the exact taxonomy with short definitions, explains Costco abbreviations ("KS" = Kirkland Signature, "ORG" = organic), and says explicitly:
  - **a wrong category is worse than no category**;
  - abstaining is always acceptable;
  - abstain on bare multi-category brands, model codes and color/style names (e.g. `CLASSIC BLUE`, `TORO BULLY`, a bare `PHILIPS`);
  - don't look anything up.
- **The prompt never asks** to reduce the Uncategorized count.
- **Server-side checks:** the server never trusts the output (`normalizeModelOutput`):
  - It parses an object or a JSON string.
  - It keeps exactly one entry per requested item; extra or duplicate items are dropped, and missing items become abstentions.
  - An unknown category, or a subcategory that does not belong to the category, becomes an **abstention**.
  - Confidence is clamped to 0–1, and percentages are converted.
  - Reasons are cleaned and capped at 200 characters.

## Review UX (Dashboard → Categories → "AI category suggestions")

- **Starting it:** **Suggest categories with AI** is the only trigger.
  - It sends automatically-Uncategorized items (no rule matched and no owner override), highest spend first.
  - Batches of 25 are sent one at a time, at most **100 items per click**.
  - The button is disabled while running, and a progress bar shows items done.
- **Deduplication:** within a review session (while the dashboard stays open), an item is never sent twice. Failed items are only re-sent with **Retry failed items**.
- **Partial failures:** a failed batch keeps every suggestion already received and shows the error.
- **Each suggestion shows** the Costco description, item number, suggested category › subcategory (or "No suggestion (AI abstained)"), confidence and reason.
- **Per-suggestion actions:**
  - **Accept**: writes the override.
  - **Change**: an inline category/subcategory picker; writes the chosen override.
  - **Leave uncategorized**: writes nothing.
- **Bulk review:**
  - **Accept all high-confidence (n)**: an explicit click; never automatic.
  - **Only uncertain**: a filter.
  - "High confidence" is `AI_SUGGESTIONS.highConfidence` (0.85) in **`src/ui/dashboard/aiConfig.ts`**. It is a display setting, not part of the prompt.

## Persistence
Accepted or changed suggestions are ordinary category overrides:
- stored in this browser's IndexedDB (`src/persistence/overridesStore.ts`);
- taking precedence over the description rules;
- reversible with **Use automatic category** in the item drawer;
- removed by **Forget imported data**.

The suggestions themselves live only in memory for the review session.

## Cost and request controls
- There is no background or scheduled classification. AI runs only after a click.
- Each click sends at most 100 items in 4 requests of 25. The button is disabled while running, and duplicates are prevented on the client.
- **Server limits:**
  - strict schema;
  - 25 items per request;
  - 24 KiB body;
  - `max_tokens` 2048;
  - a best-effort limit of **12 requests per 5 minutes per Workers isolate** (`CATEGORY_SUGGESTION_RATE_LIMIT`; in memory, no D1 change).

## Pricing (informational)
This is Cloudflare's Workers AI pricing model as of this change. The app makes no billing assumptions: it never counts neurons and has no plan-specific logic.
- Workers AI includes a free allocation of **10,000 neurons per day**.
- **Workers Free plan:** requests beyond the daily free allocation **fail** rather than being charged automatically. In the dashboard that shows up as an ordinary `ai_failed` batch error, with **Retry failed items** available later. Nothing changes.
- **Workers Paid plan:** usage above the free allocation **is charged** at Cloudflare's per-neuron rate.
- An occasional review of a few hundred items is expected to be small relative to the daily allocation, but the actual neuron cost depends on the model and on prompt and answer length. The dashboard shows token counts when Workers AI reports them, and the Cloudflare dashboard shows actual usage.
- Check Cloudflare's current Workers AI pricing page before relying on these figures.

## Cloudflare setup
**Production (required before using AI suggestions).** The Workers AI binding is configured on the Pages project in the Cloudflare dashboard:

1. **Workers & Pages → CostcoTracker Analytics project → Settings → Bindings → Add binding → Workers AI.**
2. Binding / variable name: **`AI`** (exactly).
3. Add it for the **Production** environment (and **Preview** if you use preview deployments).
4. **Redeploy** the project. Bindings apply to deployments made after the change.
5. Check: in the dashboard, Categories → **Suggest categories with AI** should return suggestions instead of "AI suggestions are not set up on this cloud…".

Do not rely on `wrangler pages deploy` or `wrangler.toml` alone to provision the production binding.

**`wrangler.toml`** still contains:
```toml
[ai]
binding = "AI"
```
- It is valid configuration: Wrangler's own config reader parses it as `ai: { binding: "AI" }`.
- It documents the expected binding name and is used by local tooling (`wrangler pages dev`).
- It is not what provisions production; the dashboard step above is.

**Unchanged:** the D1 binding `DB`. The committed `database_id` stays the all-zero placeholder; keep your real ID out of the repository.

**Local development:**
- `npm run dev:cloud` / `wrangler pages dev` reaches Workers AI remotely and needs a logged-in Cloudflare account.
- Without that, the endpoint answers `ai_not_configured` and the rest of the app works.
- Automated tests never call Workers AI; they mock the binding.

**If the binding is missing**, AI is off and nothing else is affected:
- `POST /api/categories/suggest` answers **503 `ai_not_configured`**.
- The dashboard's AI panel shows that message.
- Analytics, overrides, Reload dashboard and every other tab work normally.

## Failure behavior
| Situation | What the owner sees | Data changed? |
|---|---|---|
| No `AI` binding on the Pages project | "AI suggestions are not set up on this cloud: … Add it under Settings → Bindings, then redeploy." The rest of the dashboard works | No |
| Model error, JSON Mode failure, or the daily free allocation used up (Workers Free) | "Some items could not be classified (n)" plus **Retry failed items** | No |
| Some batches fail | Successful suggestions stay reviewable | No |
| Invalid model output | That item shows as abstained | No |
| Rate limit | "Too many AI suggestion requests…" | No |
| Session expired | Normal sign-in screen | No |
