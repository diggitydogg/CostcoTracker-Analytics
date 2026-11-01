# Privacy Design

CostcoTracker Analytics is **owner-controlled and privacy-first**. It is a single-user app. The owner deploys it to their own Cloudflare account, and the data goes nowhere else. The full design is in `docs/CLOUD_ARCHITECTURE.md` §9.

## Where data lives

| Place | What | Role |
|---|---|---|
| CostcoTracker iOS | Everything it collects, including Costco sign-in | Source of truth. Costco credentials **never** leave the device. |
| Cloudflare D1 (owner's account) | Export V1 analytics fields only | Durable analytics store. |
| Browser (IndexedDB) | A cached copy of the analytics data | Optional, per device, can be deleted. |

Cloudflare acts as a data processor for the owner. D1 is encrypted at rest by Cloudflare, but the data is **not** end-to-end encrypted, so Cloudflare can technically access it. The owner accepts this trade-off by deploying the cloud mode. Section 13 of the architecture document describes the self-hosted alternative.

## What is never stored in the cloud
- Costco cookies, passwords, tokens or any session material.
  - The sync API rejects payloads containing credential-like or barcode-like field names.
- Receipt or transaction barcodes, synthetic `WHSE_` keys, online order numbers.
  - Opaque, keyed-hash IDs are used instead.
- Payment card data, account profile, return photos, device identifiers, IP addresses.

Owner access keys, session tokens, device tokens and enrollment codes are stored only as SHA-256 digests.

## Third parties

The application must not transmit analytics data to:
- an analytics provider
- an error-reporting provider
- an AI provider
- any party other than the owner's own deployment

This holds unless a feature explicitly asks for permission and clearly describes the exact data being sent. Such features are the optional AI category suggestions and product identification by web search, described below.

The browser enforces this with a Content Security Policy of `connect-src 'self'`. The page can only call the owner's own same-origin API, never a third-party origin. There are no analytics, telemetry, web fonts or CDNs.

The cloud sign-in uses the owner access key:
- The key is only sent to the owner's own API.
- It is never written to browser storage.
- Only an HttpOnly session cookie is kept.

## Local browser cache
- Stored in IndexedDB on the current browser/device.
- Clearly indicated when present.
- A visible `Forget imported data` action removes the dataset and derived local caches.
- Forgetting local data does not delete cloud data. Cloud data is removed by the owner, either by deleting records or by deleting the D1 database.

## Telemetry

No behavioral analytics or advertising trackers. Server logs contain only route, status and error code, never request bodies or record values.

## AI categorization

AI category suggestions are **optional**, available only in cloud mode, and run only when the owner clicks **Suggest categories with AI**. The panel states exactly what is sent before the click. They use **Cloudflare Workers AI** through the owner's own Cloudflare account, the same provider that already hosts the deployment. No other AI provider or API key is involved, and the browser still only talks to its own origin.

Request payload (enforced by a strict schema and tests):
- item number
- up to 3 item description variants (cleaned, at most 120 characters each)

Never sent: receipt/order IDs or numbers, barcodes, purchase dates, warehouse or location, prices, spend, quantities, returns or adjustment amounts, other receipt contents, or any account, session, device or Costco credential data.

AI output is a suggested category, never source truth. Nothing changes until the owner accepts or edits a suggestion, which then becomes an ordinary browser-side category override. Suggestions are not stored in the cloud. Details: `docs/AI_CATEGORY_SUGGESTIONS.md`.

## Product identification (web search)

Optional and cloud-only. It runs only when the owner clicks **Suggest categories with AI**, which first looks up Uncategorized item numbers. For an item number not already in the cache, the server sends **only** the word "Costco", the Costco item number and the abbreviated receipt description to the configured web search provider (Brave Search API, via the owner's own `SEARCH_API_KEY`). This is the only feature that sends data to a party other than Cloudflare. No barcode, order number, date, warehouse, price, quantity, purchase history, account or device data is sent, and no website (including costco.com) is fetched or scraped. Results (public product name, brand, type, source URL) are cached in the owner's D1 so each item number is looked up once. Details: `docs/PRODUCT_IDENTIFICATION.md`.

## Demo / testing data

Only synthetic purchase data may be committed to the repository.
