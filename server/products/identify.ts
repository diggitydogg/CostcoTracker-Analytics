/**
 * Product identification pipeline (owner-only, POST /api/products/identify):
 *
 *   1. D1 cache lookup by item number (product_identities).
 *   2. Cache hit → returned immediately; a recent "not_found" is not retried.
 *   3. Cache miss → targeted public web search (item number + receipt
 *      description, then the quoted item number). A result must contain the
 *      exact item number to count.
 *   4. Optional Workers AI normalization of the found results (one call per
 *      batch): clean name, brand, product type. Without AI, or if it fails,
 *      the cleaned search-result title is used.
 *   5. Cache the outcome so the item number is researched only once.
 *
 * Categorization happens afterwards in the dashboard (deterministic rules on
 * the identified name; AI suggestions with owner review for what remains).
 */
import { cleanDescription, type SuggestRequestItem } from '../../src/analytics/categories/suggestProtocol'
import { isUsableIdentity, type IdentifyResponse, type IdentifyResult, type ProductIdentity } from '../../src/analytics/products/identityProtocol'
import type { AiBinding } from '../ai/categorySuggest'
import { PRODUCT_NORMALIZATION_MODEL } from '../ai/config'
import type { SqlDatabase } from '../db'
import { cleanProductTitle, pickCandidate, searchQueries, type Candidate, type WebSearch } from './search'

/** A "not found" result is not searched again for this long. */
export const NOT_FOUND_RETRY_MS = 30 * 24 * 60 * 60 * 1000

type Row = {
  item_number: string
  status: 'identified' | 'provisional' | 'not_found'
  receipt_description: string
  normalized_name: string | null
  brand: string | null
  product_type: string | null
  source_url: string | null
  image_url: string | null
  confidence: number
  evidence: ProductIdentity['evidence']
  evidence_sources: number
  corroborating_url: string | null
  method: string
  looked_up_at: string
  retry_after: string | null
}

export function rowToIdentity(r: Row): ProductIdentity {
  return {
    itemNumber: r.item_number,
    status: r.status,
    receiptDescription: r.receipt_description,
    normalizedName: r.normalized_name,
    brand: r.brand,
    productType: r.product_type,
    sourceUrl: r.source_url,
    imageUrl: r.image_url,
    confidence: r.confidence,
    evidence: r.evidence,
    evidenceSources: r.evidence_sources,
    corroboratingUrl: r.corroborating_url,
    method: r.method,
    lookedUpAt: r.looked_up_at,
  }
}

const COLUMNS =
  'item_number, status, receipt_description, normalized_name, brand, product_type, source_url, image_url, confidence, evidence, evidence_sources, corroborating_url, method, looked_up_at, retry_after'

export async function listIdentities(db: SqlDatabase): Promise<ProductIdentity[]> {
  // Identified and provisional (provisional is shown for transparency but never used automatically).
  const rows = await db.all<Row>(`SELECT ${COLUMNS} FROM product_identities WHERE status IN ('identified', 'provisional') ORDER BY item_number LIMIT 20000`)
  return rows.map(rowToIdentity)
}

type Normalized = { normalizedName: string; brand: string | null; productType: string | null }

const short = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = cleanDescription(v).slice(0, max).trim()
  return t && !/^(null|none|unknown|n\/a)$/i.test(t) ? t : null
}

/** One Workers AI call that turns search results into clean name / brand / product type. Never trusted blindly. */
export async function normalizeWithAi(
  ai: AiBinding,
  found: readonly { itemNumber: string; receiptDescription: string; candidate: Candidate }[],
): Promise<Map<string, Normalized>> {
  const payload = found.map((f) => ({
    itemNumber: f.itemNumber,
    receiptDescription: f.receiptDescription,
    resultTitle: f.candidate.result.title,
    resultSnippet: f.candidate.result.snippet.slice(0, 300),
  }))
  const raw = await ai.run(PRODUCT_NORMALIZATION_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You normalize product identities for a personal Costco spending dashboard. Each input has a Costco item number, its abbreviated receipt description, and the title and snippet of a public web page that mentions that exact item number. For each item return: normalizedName (the product name as a shopper would say it, with brand and size if present, at most 80 characters), brand (or null if not clear), productType (a short generic noun phrase such as "portable power station", "bidet toilet seat", "red wine", at most 40 characters, or null). Use only the given text. Do not invent details. Return exactly one entry per input itemNumber.',
      },
      { role: 'user', content: `Normalize these ${payload.length} items. Return JSON {"items":[...]}.\n${JSON.stringify(payload)}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                itemNumber: { type: 'string' },
                normalizedName: { type: 'string' },
                brand: { type: ['string', 'null'] },
                productType: { type: ['string', 'null'] },
              },
              required: ['itemNumber', 'normalizedName', 'brand', 'productType'],
            },
          },
        },
        required: ['items'],
      },
    },
    temperature: 0,
    max_tokens: 1024,
  })
  let value: unknown = raw && typeof raw === 'object' && 'response' in raw ? (raw as { response: unknown }).response : raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  const list = value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : []
  const wanted = new Set(found.map((f) => f.itemNumber))
  const out = new Map<string, Normalized>()
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const x = e as Record<string, unknown>
    const itemNumber = typeof x.itemNumber === 'string' ? x.itemNumber : null
    const name = short(x.normalizedName, 120)
    if (!itemNumber || !wanted.has(itemNumber) || out.has(itemNumber) || !name) continue
    out.set(itemNumber, { normalizedName: name, brand: short(x.brand, 60), productType: short(x.productType, 60) })
  }
  return out
}

export type IdentifyDeps = { db: SqlDatabase; search: WebSearch | null; ai?: AiBinding | undefined; now: Date }

export async function identifyItems(deps: IdentifyDeps, items: readonly SuggestRequestItem[]): Promise<IdentifyResponse> {
  const { db, search, ai, now } = deps
  const numbers = items.map((i) => i.itemNumber)
  const cachedRows = await db.all<Row>(
    `SELECT ${COLUMNS} FROM product_identities WHERE item_number IN (${numbers.map(() => '?').join(', ')})`,
    numbers,
  )
  const cache = new Map(cachedRows.map((r) => [r.item_number, r]))
  const results = new Map<string, IdentifyResponse['results'][number]>()
  const toSearch: SuggestRequestItem[] = []

  for (const item of items) {
    const row = cache.get(item.itemNumber)
    const fresh = row && (row.status === 'identified' || (row.retry_after !== null && row.retry_after > now.toISOString()))
    // Without a search provider, even a stale provisional/not_found row is better than nothing.
    if (row && (fresh || !search)) results.set(item.itemNumber, { ...rowToIdentity(row), cached: true })
    else if (!search) results.set(item.itemNumber, { itemNumber: item.itemNumber, status: 'unavailable', reason: 'Web search is not configured.' })
    else toSearch.push(item)
  }

  // Targeted search, one item at a time; the second query only if the first finds nothing.
  const found: { itemNumber: string; receiptDescription: string; candidate: Candidate }[] = []
  const notFound: { itemNumber: string; receiptDescription: string }[] = []
  for (const item of toSearch) {
    const receiptDescription = item.descriptions[0]!
    try {
      let candidate: Candidate | null = null
      for (const query of searchQueries(item.itemNumber, receiptDescription)) {
        candidate = pickCandidate(item.itemNumber, await search!.search(query))
        if (candidate) break
      }
      if (candidate) found.push({ itemNumber: item.itemNumber, receiptDescription, candidate })
      else notFound.push({ itemNumber: item.itemNumber, receiptDescription })
    } catch (error) {
      console.error('search_error', error instanceof Error ? error.message.slice(0, 40) : 'unknown')
      results.set(item.itemNumber, { itemNumber: item.itemNumber, status: 'unavailable', reason: 'The web search failed. You can try again later.' })
    }
  }

  // Optional AI normalization, in one call, only for identities with strong evidence.
  // It may clean names; it never changes status, evidence or confidence.
  let normalized = new Map<string, Normalized>()
  const strong = found.filter((f) => f.candidate.evidence !== 'single-source')
  if (ai && strong.length > 0) {
    try {
      normalized = await normalizeWithAi(ai, strong)
    } catch (error) {
      console.error('normalize_error', error instanceof Error ? error.name : 'unknown')
    }
  }

  const at = now.toISOString()
  const fresh: IdentifyResult[] = [
    ...found.map((f): IdentifyResult => {
      const n = normalized.get(f.itemNumber)
      return {
        itemNumber: f.itemNumber,
        // One non-Costco source is only a possible match: kept for transparency, never used automatically.
        status: f.candidate.evidence === 'single-source' ? 'provisional' : 'identified',
        receiptDescription: f.receiptDescription,
        normalizedName: n?.normalizedName ?? (cleanProductTitle(f.candidate.result.title) || f.receiptDescription),
        brand: n?.brand ?? null,
        productType: n?.productType ?? null,
        sourceUrl: f.candidate.result.url,
        imageUrl: f.candidate.result.imageUrl,
        confidence: f.candidate.confidence,
        evidence: f.candidate.evidence,
        evidenceSources: f.candidate.sources,
        corroboratingUrl: f.candidate.corroboratingUrl,
        method: n ? 'web-search+ai' : 'web-search',
        lookedUpAt: at,
        cached: false,
      }
    }),
    ...notFound.map(
      (f): IdentifyResult => ({
        itemNumber: f.itemNumber,
        status: 'not_found',
        receiptDescription: f.receiptDescription,
        normalizedName: null,
        brand: null,
        productType: null,
        sourceUrl: null,
        imageUrl: null,
        confidence: 0,
        evidence: null,
        evidenceSources: 0,
        corroboratingUrl: null,
        method: 'web-search',
        lookedUpAt: at,
        cached: false,
      }),
    ),
  ]
  if (fresh.length > 0) {
    const retryAfter = new Date(now.getTime() + NOT_FOUND_RETRY_MS).toISOString()
    await db.batch(
      fresh.map((r) => ({
        sql: `INSERT INTO product_identities (${COLUMNS}, search_provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (item_number) DO UPDATE SET status = excluded.status, receipt_description = excluded.receipt_description,
                normalized_name = excluded.normalized_name, brand = excluded.brand, product_type = excluded.product_type,
                source_url = excluded.source_url, image_url = excluded.image_url, confidence = excluded.confidence,
                evidence = excluded.evidence, evidence_sources = excluded.evidence_sources, corroborating_url = excluded.corroborating_url,
                method = excluded.method, looked_up_at = excluded.looked_up_at, retry_after = excluded.retry_after,
                search_provider = excluded.search_provider`,
        params: [
          r.itemNumber,
          r.status,
          r.receiptDescription,
          r.normalizedName,
          r.brand,
          r.productType,
          r.sourceUrl,
          r.imageUrl,
          r.confidence,
          r.evidence,
          r.evidenceSources,
          r.corroboratingUrl,
          r.method,
          r.lookedUpAt,
          // Weak or missing evidence is re-checked later; a usable identity is kept.
          r.status === 'identified' ? null : retryAfter,
          search?.name ?? null,
        ],
      })),
    )
    for (const r of fresh) results.set(r.itemNumber, r)
  }
  return { searchConfigured: search !== null, results: items.map((i) => results.get(i.itemNumber)!) }
}

/** Cached identities for the AI suggestion prompt: usable ones only (Costco.com or corroborated), never provisional. */
export async function identitiesFor(db: SqlDatabase, itemNumbers: readonly string[]): Promise<Map<string, ProductIdentity>> {
  if (itemNumbers.length === 0) return new Map()
  const rows = await db.all<Row>(
    `SELECT ${COLUMNS} FROM product_identities WHERE status = 'identified' AND item_number IN (${itemNumbers.map(() => '?').join(', ')})`,
    [...itemNumbers],
  )
  return new Map(rows.map(rowToIdentity).filter(isUsableIdentity).map((i) => [i.itemNumber, i]))
}
