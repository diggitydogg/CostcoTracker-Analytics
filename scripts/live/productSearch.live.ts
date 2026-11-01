/**
 * Live validation of product identification against the real Brave Search API.
 *
 *   SEARCH_API_KEY=… npm run validate:search
 *
 * - Uses the exact production code paths: query builder, Brave adapter,
 *   exact-item-number evidence classifier and title cleaner (server/products/search.ts).
 * - Search-only: no D1, no migration, nothing persisted. Results are printed to
 *   this terminal for review and then discarded.
 * - SKUs come from a LOCAL, gitignored file (default `.live-skus.json`, or
 *   LIVE_SKUS_FILE), so your purchase list never enters the repository:
 *     [{ "itemNumber": "1234567", "description": "KS EXAMPLE", "expect": "optional note" }]
 * - Only the item number and the (sanitized) receipt description are sent, as in production.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { matchRules } from '../../src/analytics/categories/engine'
import { buildSuggestionItems } from '../../src/analytics/categories/suggestProtocol'
import { braveSearch, cleanProductTitle, pickCandidate, searchQueries, type SearchResult } from '../../server/products/search'

type Sku = { itemNumber: string; description: string; expect?: string }

const key = process.env.SEARCH_API_KEY?.trim()
const file = process.env.LIVE_SKUS_FILE ?? '.live-skus.json'
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
    expect(existsSync(file), `Create ${file} (gitignored) with [{ "itemNumber", "description" }]`).toBe(true)
    const skus = JSON.parse(readFileSync(file, 'utf8')) as Sku[]
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
      const rule = candidate && candidate.evidence !== 'single-source' ? matchRules(name) : null
      rows.push({
        itemNumber: item.itemNumber,
        description: item.descriptions[0]!,
        queries: used,
        outcome,
        confidence: candidate?.confidence ?? 0,
        sources: candidate?.sources ?? 0,
        name: name.slice(0, 70),
        ruleCategory: rule ? `${rule.rule.categoryId}${rule.rule.subcategoryId ? `/${rule.rule.subcategoryId}` : ''}` : '',
        resultHosts: hostsSeen.slice(0, 5).join(', '),
        ms: Date.now() - started,
        expect: sku.expect ?? '',
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

describe.skipIf(!!key)('live Brave product identification', () => {
  it.skip('skipped: set SEARCH_API_KEY to run', () => {})
})
