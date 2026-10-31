# Cloud Task 05 — QA, Privacy, Security, Accessibility, and Release Audit

Audit the combined app for a public v1.

Correctness:
- independently verify formulas
- double-counting
- fractional quantity
- missing prices
- date grouping
- return semantics
- adjustment semantics

Privacy:
- network calls
- telemetry
- remote logging
- accidental dataset uploads
- real Costco data
- secrets
- cookies/tokens
- console logging imported records

Security:
- malformed/huge files
- JSON parsing
- XSS/injection through imported strings
- IndexedDB clearing
- dependency issues

Accessibility/responsive:
- keyboard/focus/labels/contrast/chart alternatives/touch targets
- widths 320, 375/390, 768, 1024, 1440+

UX:
- fresh/no-data
- import
- invalid import
- remembered dataset
- forget dataset
- category correction
- drill-down provenance
- large dataset performance

Fix clear bugs within scope. Document larger design issues.

Create `RELEASE_CHECKLIST.md` and a focused PR with findings/tests/build.
