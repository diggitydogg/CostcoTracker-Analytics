/**
 * Live validation of product identification against the real Brave Search API.
 *
 *   SEARCH_API_KEY=… npm run validate:search
 *
 * - Uses the exact production code paths: query builder, Brave adapter,
 *   exact-item-number evidence classifier and title cleaner (server/products/search.ts).
 * - Search-only: no D1, no migration, nothing persisted. Results are printed to
 *   this terminal for review and then discarded.
 * - SKUs come from one of two local sources (nothing is ever committed):
 *   1. LIVE_SKUS_FROM_EXPORT=<Export V1 file>, e.g. the dashboard's Backup
 *      download: the file is validated by the normal importer and read only.
 *      Distinct non-empty item numbers are taken in file order, each once with
 *      the receipt description of its first occurrence; LIVE_OFFSET (default 0)
 *      of them are skipped and the next LIVE_N (default 15) are tested, so
 *      LIVE_OFFSET=0 is the first batch, LIVE_OFFSET=15 the next, and so on.
 *      Nothing else from the file is used.
 *   2. Otherwise a manual list in `.live-skus.json` (gitignored) or LIVE_SKUS_FILE:
 *        [{ "itemNumber": "1234567", "description": "KS EXAMPLE", "expect": "optional note" }]
 * - Only the item number and the (sanitized) receipt description are sent, as in production.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { matchRules } from '../../src/analytics/categories/engine'
import { importExportText } from '../../src/domain/import/importExport'
import { buildSuggestionItems } from '../../src/analytics/categories/suggestProtocol'
import { braveSearch, cleanProductTitle, pickCandidate, searchQueries, type SearchResult } from '../../server/products/search'

type Sku = { itemNumber: string; description: string; expect?: string }

const key = process.env.SEARCH_API_KEY?.trim()
const file = process.env.LIVE_SKUS_FILE ?? '.live-skus.json'
const exportFile = process.env.LIVE_SKUS_FROM_EXPORT?.trim()
const batchSize = Number(process.env.LIVE_N ?? 15)
const offset = Number(process.env.LIVE_OFFSET ?? 0)
/** Stay well under Brave's per-second limit. */
const DELAY_MS = Number(process.env.LIVE_DELAY_MS ?? 1100)
const MAX_SKUS = 25

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return '?'
  }
}

describe.skipIf(!key)('live Brave product identification', () => {
  it('classifies representative Costco SKUs (search only, nothing stored)', async () => {
    expect(Number.isInteger(offset) && offset >= 0, 'LIVE_OFFSET must be a whole number ≥ 0').toBe(true)
    expect(Number.isInteger(batchSize) && batchSize >= 1, 'LIVE_N must be a whole number ≥ 1').toBe(true)
    const skus = exportFile ? distinctSkus(exportFile, offset, batchSize) : manualSkus()
    if (exportFile) console.log(`Distinct SKUs #${offset + 1}–#${offset + skus.length} (LIVE_OFFSET=${offset}, LIVE_N=${batchSize}) from the export file`)
    expect(skus.length).toBeGreaterThan(0)
    expect(skus.length, `At most ${MAX_SKUS} SKUs per run`).toBeLessThanOrEqual(MAX_SKUS)

    const search = braveSearch(key!)
    const rows: Record<string, string | number>[] = []
    let queries = 0
    let parsedResults = 0
    for (const sku of skus) {
      // Same sanitizing as the dashboard request builder.
      const [item] = buildSuggestionItems([{ itemNumber: sku.itemNumber, descriptions: [sku.description] }])
      if (!item) {
        rows.push({ itemNumber: sku.itemNumber, outcome: 'skipped (invalid item number/description)' })
        continue
      }
      const started = Date.now()
      let candidate = null
      let used = 0
      let error = ''
      let hostsSeen: string[] = []
      for (const query of searchQueries(item.itemNumber, item.descriptions[0]!)) {
        used += 1
        queries += 1
        let results: SearchResult[]
        try {
          results = await search.search(query)
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
          break
        }
        parsedResults += results.length
        hostsSeen = [...new Set(results.map((r) => host(r.url)))]
        candidate = pickCandidate(item.itemNumber, results)
        await sleep(DELAY_MS)
        if (candidate) break
      }
      const name = candidate ? cleanProductTitle(candidate.result.title) : ''
      const outcome = error
        ? `error: ${error}`
        : !candidate
          ? 'not_found'
          : candidate.evidence === 'single-source'
            ? 'unresolved (provisional)'
            : `resolved (${candidate.evidence})`
      // Would a deterministic rule categorize it? (Receipt text first, then the resolved name, as in the engine.)
      const receiptRule = matchRules(item.descriptions[0]!)
      const nameRule = !receiptRule && candidate && candidate.evidence !== 'single-source' ? matchRules(name) : null
      const rule = receiptRule ?? nameRule
      rows.push({
        itemNumber: item.itemNumber,
        description: item.descriptions[0]!,
        queries: used,
        outcome,
        confidence: candidate?.confidence ?? 0,
        sources: candidate?.sources ?? 0,
        basis: candidate ? candidate.evidence : '',
        name: name.slice(0, 70),
        ruleCategory: rule ? `${rule.rule.categoryId}${rule.rule.subcategoryId ? `/${rule.rule.subcategoryId}` : ''} (${receiptRule ? 'receipt text' : 'resolved name'})` : 'none',
        resultHosts: hostsSeen.slice(0, 5).join(', '),
        ms: Date.now() - started,
        ...(sku.expect ? { expect: sku.expect } : {}),
      })
    }

    console.table(rows)
    const count = (p: string) => rows.filter((r) => String(r.outcome).startsWith(p)).length
    console.log(
      `\n${skus.length} SKUs · ${queries} Brave queries (≤ 2 per SKU) · resolved ${count('resolved')} · provisional ${count('unresolved')} · not found ${count('not_found')} · errors ${count('error')}`,
    )
    // The adapter must actually parse Brave's live response format.
    expect(parsedResults, 'Brave returned no parseable results at all: check the key, plan and response format').toBeGreaterThan(0)
    expect(queries).toBeLessThanOrEqual(skus.length * 2)
  })
})

/**
 * Distinct non-empty item numbers in an Export V1 file (read-only), in file
 * order, each with its first receipt description: skips the first `offset`
 * and returns up to `n`. The ordering is stable, so batches never overlap.
 */
function distinctSkus(path: string, offset: number, n: number): Sku[] {
  expect(existsSync(path), `Export file not found: ${path}`).toBe(true)
  const parsed = importExportText(readFileSync(path, 'utf8'))
  if (!parsed.ok) throw new Error(`Not a valid Export V1 file: ${parsed.error.message}`)
  const out: Sku[] = []
  const seen = new Set<string>()
  for (const item of parsed.data.items) {
    const itemNumber = item.itemNumber.trim()
    const description = item.description.trim()
    if (!itemNumber || !description || seen.has(itemNumber)) continue
    seen.add(itemNumber)
    if (seen.size <= offset) continue // belongs to an earlier batch
    // Only these two fields leave this function: no price, date, quantity, receipt or warehouse data.
    out.push({ itemNumber, description })
    if (out.length === n) break
  }
  expect(out.length, `No SKUs left after LIVE_OFFSET=${offset} (the file has ${seen.size} distinct item numbers)`).toBeGreaterThan(0)
  return out
}

function manualSkus(): Sku[] {
  expect(existsSync(file), `Set LIVE_SKUS_FROM_EXPORT=<backup .json>, or create ${file} (gitignored) with [{ "itemNumber", "description" }]`).toBe(true)
  return JSON.parse(readFileSync(file, 'utf8')) as Sku[]
}

describe.skipIf(!!key)('live Brave product identification', () => {
  it.skip('skipped: set SEARCH_API_KEY to run', () => {})
})
