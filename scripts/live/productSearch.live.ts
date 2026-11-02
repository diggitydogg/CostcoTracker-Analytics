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
 *      LIVE_ITEMS=<itemNumber,…> instead picks just those item numbers (with
 *      their first receipt description), e.g. LIVE_ITEMS=1890009 to recheck one SKU.
 *      Nothing else from the file is used.
 *   2. Otherwise a manual list in `.live-skus.json` (gitignored) or LIVE_SKUS_FILE:
 *        [{ "itemNumber": "1234567", "description": "KS EXAMPLE", "expect": "optional note" }]
 * - Only the item number and the (sanitized) receipt description are sent, as in production.
 *
 * Optional AI normalization (LIVE_AI_NORMALIZE=1): for strong (resolved)
 * matches only, runs the production normalization step
 * (normalizeStrongCandidates → toResolvedIdentity in server/products/identify.ts:
 * same model, prompt, JSON schema, validation and fallback), in chunks of at
 * most 10 like one identify request. Provisional/not-found items are never
 * normalized and never shown as resolved. Locally the Pages `AI` binding is
 * replaced by workersAiRest.ts, which sends the identical input to the Workers
 * AI REST API; it needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
 * (permission "Workers AI"). Prints `searchName` (cleaned Brave title) and
 * `canonicalName` (what would be saved). Still nothing is persisted.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { matchRules } from '../../src/analytics/categories/engine'
import { importExportText } from '../../src/domain/import/importExport'
import { buildSuggestionItems } from '../../src/analytics/categories/suggestProtocol'
import { IDENTIFY_LIMITS } from '../../src/analytics/products/identityProtocol'
import { normalizeStrongCandidates, toResolvedIdentity, type Normalized, type StrongCandidate } from '../../server/products/identify'
import { braveSearch, cleanProductTitle, isStrong, lookupCandidate, MAX_QUERIES_PER_ITEM, type Candidate } from '../../server/products/search'
import { workersAiRest } from './workersAiRest'

type Sku = { itemNumber: string; description: string; expect?: string }

const key = process.env.SEARCH_API_KEY?.trim()
const file = process.env.LIVE_SKUS_FILE ?? '.live-skus.json'
const exportFile = process.env.LIVE_SKUS_FROM_EXPORT?.trim()
const batchSize = Number(process.env.LIVE_N ?? 15)
const offset = Number(process.env.LIVE_OFFSET ?? 0)
const aiNormalize = process.env.LIVE_AI_NORMALIZE === '1'
const onlyItems = (process.env.LIVE_ITEMS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
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
    const skus = exportFile ? (onlyItems.length > 0 ? pickedSkus(exportFile, onlyItems) : distinctSkus(exportFile, offset, batchSize)) : manualSkus()
    if (exportFile && onlyItems.length > 0) console.log(`Selected item numbers (LIVE_ITEMS): ${skus.map((s) => s.itemNumber).join(', ')}`)
    else if (exportFile) console.log(`Distinct SKUs #${offset + 1}–#${offset + skus.length} (LIVE_OFFSET=${offset}, LIVE_N=${batchSize}) from the export file`)
    expect(skus.length).toBeGreaterThan(0)
    expect(skus.length, `At most ${MAX_SKUS} SKUs per run`).toBeLessThanOrEqual(MAX_SKUS)

    // Fail clearly (never silently skip) when AI normalization was requested but cannot run.
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
    const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
    if (aiNormalize) {
      expect(accountId && apiToken, 'LIVE_AI_NORMALIZE=1 needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI permission)').toBeTruthy()
    }
    const ai = aiNormalize ? workersAiRest(accountId!, apiToken!) : undefined

    const search = braveSearch(key!)
    const rows: Record<string, string | number>[] = []
    const candidates = new Map<string, { item: StrongCandidate | null; weak: Candidate | null }>()
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
      let candidate: Candidate | null = null
      let used = 0
      let error = ''
      const hostsSeen = new Set<string>()
      // The production lookup (query order, early stop, query bound and evidence checks), with a delay between queries.
      try {
        const out = await lookupCandidate(search, item.itemNumber, item.descriptions[0]!, {
          beforeQuery: async (_q, i) => {
            if (i > 0 || queries > 0) await sleep(DELAY_MS)
          },
          onResults: (_query, results) => {
            used += 1
            queries += 1
            parsedResults += results.length
            for (const r of results) hostsSeen.add(host(r.url))
          },
        })
        candidate = out.candidate
      } catch (e) {
        used += 1
        queries += 1
        error = e instanceof Error ? e.message : String(e)
      }
      const strong = candidate && isStrong(candidate)
      candidates.set(item.itemNumber, {
        item: strong ? { itemNumber: item.itemNumber, receiptDescription: item.descriptions[0]!, candidate: candidate! } : null,
        weak: strong ? null : candidate,
      })
      const outcome = error
        ? `error: ${error}`
        : !candidate
          ? 'not_found'
          : candidate.evidence === 'single-source'
            ? 'unresolved (provisional)'
            : `resolved (${candidate.evidence})`
      rows.push({
        itemNumber: item.itemNumber,
        description: item.descriptions[0]!,
        queries: used,
        outcome,
        confidence: candidate?.confidence ?? 0,
        sources: candidate?.sources ?? 0,
        basis: candidate ? candidate.evidence : '',
        resolvedBy: strong ? (['normal', 'site:warehouserunner', 'quoted item #'][used - 1] ?? '') : '',
        resultHosts: [...hostsSeen].slice(0, 5).join(', '),
        ms: Date.now() - started,
        ...(sku.expect ? { expect: sku.expect } : {}),
      })
    }

    // Optional production AI normalization, strong matches only, ≤ 10 per call (one identify request).
    const strongItems = [...candidates.values()].flatMap((c) => (c.item ? [c.item] : []))
    const normalized = new Map<string, Normalized>()
    let aiCalls = 0
    if (ai) {
      for (let i = 0; i < strongItems.length; i += IDENTIFY_LIMITS.maxItemsPerRequest) {
        const chunk = strongItems.slice(i, i + IDENTIFY_LIMITS.maxItemsPerRequest)
        aiCalls += 1
        for (const [k, v] of await normalizeStrongCandidates(ai, chunk)) normalized.set(k, v)
      }
    }

    // Names and rules: what would actually be saved, and what the engine would match (receipt text first).
    const at = new Date().toISOString()
    const names: Record<string, string>[] = []
    for (const row of rows) {
      const c = candidates.get(String(row.itemNumber))
      const record = c?.item ? toResolvedIdentity(c.item, normalized.get(c.item.itemNumber), at) : null
      const receiptRule = matchRules(String(row.description ?? ''))
      const identityRule = !receiptRule && record ? (matchRules(record.canonicalName) ?? (record.productType ? matchRules(record.productType) : null)) : null
      const rule = receiptRule ?? identityRule
      row.rule = rule ? `${rule.rule.categoryId}${rule.rule.subcategoryId ? `/${rule.rule.subcategoryId}` : ''} (${receiptRule ? 'receipt text' : 'canonical name'})` : 'none'
      names.push({
        itemNumber: String(row.itemNumber),
        description: String(row.description ?? ''),
        searchName: c?.item ? cleanProductTitle(c.item.candidate.result.title) : c?.weak ? `${cleanProductTitle(c.weak.result.title)} [provisional, not resolved]` : '',
        canonicalName: record ? record.canonicalName : '— (not resolved: nothing would be saved)',
        brand: record?.brand ?? '',
        productType: record?.productType ?? '',
        method: record ? record.method : '',
      })
    }

    console.table(rows)
    console.table(names)
    if (aiNormalize) {
      const normalizedCount = [...normalized.keys()].length
      console.log(`AI normalization: ${aiCalls} call(s) for ${strongItems.length} resolved item(s); ${normalizedCount} normalized, ${strongItems.length - normalizedCount} fell back to the search name (method "web-search").`)
    } else {
      console.log('AI normalization off (set LIVE_AI_NORMALIZE=1): canonicalName is the cleaned search title, as production saves it without the AI binding.')
    }
    const count = (p: string) => rows.filter((r) => String(r.outcome).startsWith(p)).length
    console.log(
      `\n${skus.length} SKUs · ${queries} Brave queries (≤ ${MAX_QUERIES_PER_ITEM} per SKU) · resolved ${count('resolved')} · provisional ${count('unresolved')} · not found ${count('not_found')} · errors ${count('error')}`,
    )
    // The adapter must actually parse Brave's live response format.
    expect(parsedResults, 'Brave returned no parseable results at all: check the key, plan and response format').toBeGreaterThan(0)
    expect(queries).toBeLessThanOrEqual(skus.length * MAX_QUERIES_PER_ITEM)
  })
})

function readExportItems(path: string) {
  expect(existsSync(path), `Export file not found: ${path}`).toBe(true)
  const parsed = importExportText(readFileSync(path, 'utf8'))
  if (!parsed.ok) throw new Error(`Not a valid Export V1 file: ${parsed.error.message}`)
  return parsed.data.items
}

/** Just the requested item numbers, each with its first non-empty receipt description (read-only). */
function pickedSkus(path: string, wanted: readonly string[]): Sku[] {
  expect(wanted.length, `At most ${MAX_SKUS} LIVE_ITEMS per run`).toBeLessThanOrEqual(MAX_SKUS)
  const first = new Map<string, string>()
  for (const item of readExportItems(path)) {
    const itemNumber = item.itemNumber.trim()
    const description = item.description.trim()
    if (itemNumber && description && !first.has(itemNumber)) first.set(itemNumber, description)
  }
  const missing = wanted.filter((n) => !first.has(n))
  expect(missing, `LIVE_ITEMS not found in the export file: ${missing.join(', ')}`).toEqual([])
  // Only these two fields leave this function.
  return [...new Set(wanted)].map((itemNumber) => ({ itemNumber, description: first.get(itemNumber)! }))
}

/**
 * Distinct non-empty item numbers in an Export V1 file (read-only), in file
 * order, each with its first receipt description: skips the first `offset`
 * and returns up to `n`. The ordering is stable, so batches never overlap.
 */
function distinctSkus(path: string, offset: number, n: number): Sku[] {
  const out: Sku[] = []
  const seen = new Set<string>()
  for (const item of readExportItems(path)) {
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
