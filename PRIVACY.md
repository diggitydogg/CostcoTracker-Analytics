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

This holds unless a future feature explicitly asks for permission and clearly describes the exact data being sent.

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

Future AI-assisted categorization must be optional.

Preferred minimal request payload:
- item number
- item description

Do not send receipt/order number, barcode, purchase date, warehouse, price paid, quantity, full receipt, or account/session information.

AI output must be treated as a suggested category, not source truth.

## Demo / testing data

Only synthetic purchase data may be committed to the repository.
