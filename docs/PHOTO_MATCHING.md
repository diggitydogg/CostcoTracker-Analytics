# Photo-to-product matching

Take or choose a photo of a Costco item you own (its label, package, or the shelf tag), and the app finds which of *your* Costco items it most likely is. This is the first step of the return flow: photo → product → **purchase history and receipt (PR #11)** → **verified product links (PR #12)**.

It builds on the existing product-identity system (PR #7, PR #8). Results point to existing item numbers and catalog identities; there is no second catalog.

## Pipeline: deterministic evidence first

The iOS app reads shelf tags and packaging with Apple Vision OCR and barcode recognition. The web app follows the same idea: read deterministic evidence on the device first and match it locally. A general-purpose AI model sees the photo only when that is not enough, and only when the owner asks.

```
photo ─► 1a. on-device evidence (browser): barcodes + OCR text, numbers ─► 2. local match (browser) ─► strong match? done
                                                                                 │ not identified
                                                                                 ▼  (owner clicks "Analyze photo with AI")
           1b. AI description (Workers AI, owner's Cloudflare): brand, name, variant, size… ─► 2. local match again
                                                                                 │ still no strong local match
                                                                                 ▼
           3. external identification (Brave, generic product text only) ─► 4. ranked candidates ─► 5. owner confirms
```

| Stage | Where | What it does | Code |
|---|---|---|---|
| Prepare | Browser | Decodes JPEG/PNG/WebP, and HEIC where the browser can (Safari). Applies the EXIF orientation. Scales to 1280px on the longest side and re-encodes as JPEG (quality 0.9 → 0.6, the highest that fits 1.2 MB). Re-encoding **drops all metadata**: location, device, time | `src/ui/photo/prepareImage.ts` |
| 1a. On-device evidence | Browser | Barcodes: the browser's `BarcodeDetector` where available, else ZXing (JS). Text: Tesseract (WebAssembly, English LSTM), self-hosted under `/ocr/` and loaded only when used. Every standalone 4–8 digit number is collected, which covers Costco item numbers on shelf tags | `src/ui/photo/onDevice.ts`, `evidenceFromText` |
| 2. Local match | Browser | Deterministic scoring against the owner's items and catalog identities (see below) | `matchLocal` in `src/analytics/products/photoMatch.ts` |
| 1b. AI description | Server → Workers AI | **Only on request.** The model describes what is visible (brand, name, variant, size, type, model number, printed UPC, Costco item number, packaging text) as JSON. The server validates every field | `server/products/photo.ts` |
| 3. External | Server → Brave | **Only if still no strong local match and the photo named a product.** Searches `Costco <brand> <name> <variant>`, then `site:app.warehouserunner.com <brand> <name>`. Keeps only item numbers a result verifiably names | `searchPhotoCandidates` |
| 4. Ranking | Browser | Candidates with confidence, reasons and sources; status *match / candidates / low-confidence / none / unreadable* | `mergeExternal`, `decide` |
| 5. Confirmation | Browser | The owner chooses. Nothing is saved or overwritten automatically | `PhotoMatchSheet` |

**A typed fallback:** the owner can type the item number or the text on the tag. For example, an iPhone user can copy it with Live Text. This is matched exactly like OCR text, with no network.

### Local scoring (deterministic, tested)

- **An item number the owner bought is decisive (0.97)** when it is visible in the photo's text or encoded in a barcode, for example on a shelf tag.
- **Structured evidence** (from AI): the visible product name carries 60%, brand 25%, and variant/type/size 15%. It is compared with our catalog name, brand and type, and with the receipt descriptions.
  - Receipt descriptions count 0.9× because they are abbreviated.
  - Abbreviations are understood: "TORT" counts for "TORTELLINI", and receipt "KS" for Kirkland Signature.
- **Raw text** (OCR or typed): how much of the item's own name appears in the photo's text. One matching word is weak; two or more make a real match.
- **Trust in identities:** an owner-confirmed identity gets +0.08 and the reason "You confirmed this product". An automatic identity matched by name gets +0.03. Confidence never exceeds 0.95 unless an item number was read.
- **Thresholds:**
  - strong ≥ 0.75;
  - plausible ≥ 0.45;
  - shown ≥ 0.25;
  - shown alone as "the" match only when it leads the next candidate by ≥ 0.15.

  Several items with the same receipt text are therefore shown as candidates. They are never silently picked.
- **External candidates** start from their source's confidence (Costco.com 0.7, Warehouse Runner 0.65, other web 0.4), scaled by how well the listing title agrees with the photo. If the owner bought that item number, it joins the local candidate as combined evidence.

## What leaves the device, and what never does

| Step | Recipient | What is sent | What is never sent |
|---|---|---|---|
| 1a, 2 | Nobody | Nothing. The photo is processed in the browser; the OCR files are fetched from this app's own origin | — |
| 1b (on request) | **Cloudflare Workers AI**, in the owner's own Cloudflare account, through the Pages `AI` binding: the same provider and account that already host the app and run AI suggestions | One re-encoded JPEG (≤ 1280px, ≤ 1.2 MB, **no EXIF**: no location, device or time) plus a fixed instruction. The request schema is strict: `{ image }` only | Purchase history, receipts or receipt IDs, item numbers, prices, dates, warehouses, account, session or device data, the original file |
| 3 (if needed) | **Brave Search API** (the owner's `SEARCH_API_KEY`) | Brand, product name and variant as read from the photo (generic product text: CLAUDE.md's product-identification exception), plus "Costco" or `site:app.warehouserunner.com`. Strict schema | The photo, receipt text, item numbers, prices, dates, warehouses, purchase history, account data |

- **Retention:**
  - **Cloudflare:** its Workers AI privacy policy states that customer content (inputs such as image submissions, and outputs) is not used to train models or improve services without explicit consent. Cloudflare stores it only if combined with a storage product (R2, KV, D1…), and this feature does not do that. It was read via search because developers.cloudflare.com is not reachable from this build environment, so check the current policy before relying on it.
  - **Brave:** receives text only; its standard terms apply as for product identification.
- **Persistence:** the app persists **nothing** from photo matching:
  - not the photo (it exists only in browser memory while the sheet is open);
  - not the evidence;
  - not the results.

  The one exception is an explicit owner action: "Save as my product…" writes an owner-confirmed identity through the existing PR #8 workflow. The OCR model is cached by the browser (IndexedDB / HTTP cache) like any app file. It contains no personal data.
- **Server endpoints never read purchase data.** They don't query `receipts` or `items`; local matching happens in the browser. Tests sync synthetic purchases into D1, then assert that none of their values appear in the AI input or the search queries, and that D1 is byte-identical afterwards.
- **Model:** `@cf/meta/llama-4-scout-17b-16e-instruct`, set in `server/ai/config.ts`.
  - **Input format:** the image is sent as an OpenAI-style `image_url` data URI in the user message, the multimodal format used for this model on Workers AI.
  - **Not verified against the primary docs:** Cloudflare's model documentation could not be fetched from this environment. The first production smoke test confirms the payload. If Workers AI rejects it, only `buildEvidenceInput` changes.
  - **Image size:** kept small because a community report describes ~1.9 MB inline images timing out.

## UX

- **Entry point:** **Items → Item explorer → "Find item from photo"** (cloud mode). The local-file mode has no server, so no AI or search; on-device matching there is a possible follow-up.
- **Presentation:** a **modal sheet at every width**. Choosing and analyzing a photo is a blocking task (Apple's sheet guidance), so it isn't forced into the docked detail pane.
  - It comes in from the trailing edge like the detail sheet.
  - It is rendered into `<body>`, so it can't reflow the list.
  - Focus goes to Close on open and returns to the opener on close, without scrolling (PR #9 rules).
- **Flow:**
  1. **Take photo** (camera on iPhone, via `capture="environment"`) or **Choose photo** (library).
  2. Reading on the device, with an accessible progress status.
  3. The result:
     - **one strong match**;
     - **a few possible matches** to choose from;
     - **only weak matches**;
     - **no match** (with tips);
     - **couldn't read this photo** (with tips).
  4. Each candidate card shows:
     - name, item number and brand;
     - a **text** confidence label with a percentage, so meaning isn't carried by color alone;
     - an "Owner confirmed" badge where it applies;
     - the reasons and the sources;
     - the purchase link: "Bought 2 times, last on …", "No purchase record — seen only in returns or price adjustments", or "Not in your purchases".
  5. **"This is it — open item"** closes the sheet and opens the item's detail. At split-capable widths it's the docked pane beside the list (PR #9); otherwise the detail sheet. The drawer notes "Opened from your photo: you confirmed this match (…)".
  6. If not identified: **"Analyze photo with AI"**, which explains that only the photo is sent. **Try another photo** and the typed field are always there.
- **List stability (PR #9):** when the matched item opens in the pane, the list rows on screen stay still. The anchor is the matched row if visible, else the first visible row, passed through `open(drill, { anchor })`. Focus goes to the matched row if visible, else back to the photo button. Real browser: 0px row movement at 375, 844, 1180, 1440 and 200% text.

## Uncertainty and confirmation

- Candidates are ranked, never collapsed into false certainty. "Match" requires ≥ 0.75 *and* a clear lead.
- **Confirming** produces a `ConfirmedPhotoMatch`: item number, canonical name, identity, confidence, sources, `confirmation: 'owner-confirmed-match'` and a time. It is passed to the item drawer through the drill (`{ kind: 'item', itemNumber, match }`). PR #11 consumes the same structure, and the drawer already links to the purchase history (lines, receipts).
- **Saving an identity** ("Save as my product…") is offered only for an item the owner bought that has **no** identity. It goes through the existing owner-confirmed workflow (`catalog.confirm`), prefilled from the photo but saved only on submit. **Existing identities, owner-confirmed or automatic, are never overwritten** from a photo; to change one, the owner uses Edit identity in the drawer.

## API

| Request | Body | Response |
|---|---|---|
| `POST /api/products/photo/evidence` (owner, strict, ≤ 1.7 MB, 20 / 10 min) | `{ image: "data:image/jpeg;base64,…" }` | `{ evidence }`. 503 `ai_not_configured`, 502 `ai_failed` |
| `POST /api/products/photo/search` (owner, strict, ≤ 2 KiB, 20 / 10 min) | `{ brand \| null, productName, variant \| null }` | `{ searchConfigured, candidates: [{ itemNumber, title, basis }] }`. 502 `search_failed` |

There are no D1 schema changes and no migrations.

## Product links (investigated for PR #12, not built)

- When identification resolves an item from **Costco.com**, the Costco product URL is seen transiently (Brave result) and discarded. `product_identities` has no URL column, by design.
- A future, verified `canonical_url` would need:
  - a new column (migration);
  - **only Costco.com product-page URLs** (host `costco.com`, path `*.product.<id>.html`) for items resolved with basis `costco.com`, or entered or confirmed by the owner;
  - **never a URL constructed from an item number.**
- **Open question:** whether storing a URL first seen in a Brave result is within Brave's terms. It may need owner confirmation or a separate verification step. Deferred to PR #12; nothing is stored now.

## Deferred

- **PR #11 (return assistant):** the receipt for a confirmed item, purchase selection, the barcode for returns, and return recommendations.
- **PR #12:** verified "View on Costco.com" and product links; catalog/return-flow polish.
- **Possible follow-ups:**
  - on-device matching in local-file mode;
  - live camera scanning (`getUserMedia`) instead of still photos;
  - more OCR languages.

## Testing

- **Matching** (`photoMatch.test.ts`):
  - OCR item number decides;
  - barcode decides;
  - packaging text matches abbreviated receipts;
  - a strong local match;
  - owner-confirmed is preferred;
  - multiple plausible candidates;
  - none;
  - a single word is not enough;
  - low confidence;
  - external fallback text, and merging external candidates;
  - combining evidence;
  - KS = Kirkland Signature;
  - confirmation never overwrites, and the `ConfirmedPhotoMatch` shape.
- **Server** (`server/test/photoMatch.test.ts`):
  - AI input is exactly the prompt and the image;
  - synced purchase data never reaches AI or search;
  - D1 is unchanged;
  - strict schemas and size limit;
  - auth;
  - 503/502;
  - the normalizer rejects invented numbers and barcodes;
  - search queries and result parsing.
- **UI** (`src/ui/photo/PhotoMatch.test.tsx`, jsdom with injected device reader):
  - the entry point is cloud-only;
  - modal and focus behavior, Escape;
  - an on-device match with no AI or search, opening the drawer with the note;
  - a pane at split width;
  - the typed path;
  - AI only on request, sending the data URL only;
  - an ambiguous result as candidates;
  - search with generic text, and "not in your purchases";
  - recoverable errors;
  - save identity vs owner-confirmed.
- **Real browser** (Chromium, `wrangler pages dev` with a local D1 and synthetic data, real on-device OCR, AI endpoint mocked):

  | Viewport | OCR (shelf-tag photo) | Result | Open reachable | Detail | List rows moved | Overflow |
  |---|---|---|---|---|---|---|
  | 320×568 | — (pick screen) | — | Take/Choose 44px | — | — | 0 |
  | 375×667 | 1.4 s | strong match (item number read) | yes | sheet | 0 | 0 |
  | 844×390 | 1.4 s | strong match | yes | sheet | 0 | 0 |
  | 1180×820 | 1.4 s | strong match | yes | pane | 0 | 0 |
  | 1440×900 | 1.4 s | strong match | yes | pane | 0 | 0 |
  | 375×667 @200% | 1.4 s | strong match | yes | sheet | 0 | 0 |
  | 1180×820 @200% | 1.4 s | strong match | yes | sheet (text-size fallback) | 0 | 0 |

  - **Package-front photo** (no item number): on-device gave "A few possible matches", and the AI step sent only `{ image }`.
  - **PR #9 regressions:** reflow, pane focus and sheet focus were re-run unchanged. The viewport matrix and 200% text show no overflow.
