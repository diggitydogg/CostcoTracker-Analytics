# Privacy Design

CostcoTracker Analytics is intended to be local-first.

## Version 1

Raw imported CostcoTracker analytics data is processed in the browser.

The application should not transmit the imported dataset to:
- the website host
- an analytics provider
- an error-reporting provider
- an AI provider
- any third party

unless a future feature explicitly asks for permission and clearly describes the exact data being sent.

## Persistence

The user should be able to choose whether imported data is remembered on the device.

If remembered:
- store locally in IndexedDB
- clearly indicate that the browser/device has a saved dataset
- provide a visible `Forget imported data` action
- deletion should remove the dataset and derived local caches

## Telemetry

Version 1 should contain no behavioral analytics or advertising trackers.

## AI categorization

Future AI-assisted categorization must be optional.

Preferred minimal request payload:
- item number
- item description

Do not send receipt/order number, barcode, purchase date, warehouse, price paid, quantity, full receipt, or account/session information.

AI output must be treated as a suggested category, not source truth.

## Demo / testing data

Only synthetic purchase data may be committed to the repository.
